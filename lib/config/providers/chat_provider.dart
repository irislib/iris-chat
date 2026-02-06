import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:freezed_annotation/freezed_annotation.dart';

import '../../core/services/database_service.dart';
import '../../core/services/error_service.dart';
import '../../core/services/profile_service.dart';
import '../../core/services/session_manager_service.dart';
import '../../core/utils/nostr_rumor.dart';
import '../../features/chat/data/datasources/message_local_datasource.dart';
import '../../features/chat/data/datasources/session_local_datasource.dart';
import '../../features/chat/data/repositories/chat_repository_impl.dart';
import '../../features/chat/domain/models/message.dart';
import '../../features/chat/domain/models/session.dart';
import '../../features/chat/domain/repositories/chat_repository.dart';
import '../../features/chat/domain/utils/message_status_utils.dart';
import 'nostr_provider.dart';

part 'chat_provider.freezed.dart';

/// State for chat sessions.
@freezed
abstract class SessionState with _$SessionState {
  const factory SessionState({
    @Default([]) List<ChatSession> sessions,
    @Default(false) bool isLoading,
    String? error,
  }) = _SessionState;
}

/// State for messages in a chat.
@freezed
abstract class ChatState with _$ChatState {
  const factory ChatState({
    @Default({}) Map<String, List<ChatMessage>> messages,
    @Default({}) Map<String, int> unreadCounts,
    @Default({}) Map<String, bool> sendingStates,
    @Default({}) Map<String, bool> typingStates,
    String? error,
  }) = _ChatState;
}

/// Notifier for session state.
class SessionNotifier extends StateNotifier<SessionState> {
  SessionNotifier(this._sessionDatasource, this._profileService)
      : super(const SessionState());

  final SessionLocalDatasource _sessionDatasource;
  final ProfileService _profileService;

  /// Load all sessions from storage.
  Future<void> loadSessions() async {
    state = state.copyWith(isLoading: true, error: null);
    try {
      final sessions = await _sessionDatasource.getAllSessions();
      state = state.copyWith(sessions: sessions, isLoading: false);

      // Fetch profiles for all recipients without names
      unawaited(_fetchMissingProfiles(sessions));
    } catch (e, st) {
      final appError = AppError.from(e, st);
      state = state.copyWith(isLoading: false, error: appError.message);
    }
  }

  /// Fetch profiles for sessions without recipient names.
  Future<void> _fetchMissingProfiles(List<ChatSession> sessions) async {
    final pubkeysToFetch = sessions
        .where((s) => s.recipientName == null || s.recipientName!.isEmpty)
        .map((s) => s.recipientPubkeyHex)
        .toSet()
        .toList();

    if (pubkeysToFetch.isEmpty) return;

    // Fetch profiles in background
    await _profileService.fetchProfiles(pubkeysToFetch);

    // Update sessions with profile names
    for (final pubkey in pubkeysToFetch) {
      final profile = await _profileService.getProfile(pubkey);
      if (profile?.bestName != null) {
        await updateRecipientName(pubkey, profile!.bestName!);
      }
    }
  }

  /// Update recipient name for sessions with a given pubkey.
  Future<void> updateRecipientName(String pubkey, String name) async {
    final updatedSessions = <ChatSession>[];

    for (final session in state.sessions) {
      if (session.recipientPubkeyHex == pubkey && session.recipientName != name) {
        final updated = session.copyWith(recipientName: name);
        await _sessionDatasource.saveSession(updated);
        updatedSessions.add(updated);
      } else {
        updatedSessions.add(session);
      }
    }

    if (updatedSessions != state.sessions) {
      state = state.copyWith(sessions: updatedSessions);
    }
  }

  /// Add a new session.
  Future<void> addSession(ChatSession session) async {
    await _sessionDatasource.saveSession(session);
    state = state.copyWith(
      sessions: [session, ...state.sessions],
    );
  }

  /// Update a session.
  Future<void> updateSession(ChatSession session) async {
    await _sessionDatasource.saveSession(session);
    state = state.copyWith(
      sessions: state.sessions
          .map((s) => s.id == session.id ? session : s)
          .toList(),
    );
  }

  /// Delete a session.
  Future<void> deleteSession(String id) async {
    await _sessionDatasource.deleteSession(id);
    state = state.copyWith(
      sessions: state.sessions.where((s) => s.id != id).toList(),
    );
  }

  /// Update session with new message info.
  Future<void> updateSessionWithMessage(
    String sessionId,
    ChatMessage message,
  ) async {
    await _sessionDatasource.updateMetadata(
      sessionId,
      lastMessageAt: message.timestamp,
      lastMessagePreview: message.text.length > 50
          ? '${message.text.substring(0, 50)}...'
          : message.text,
    );

    state = state.copyWith(
      sessions: state.sessions.map((s) {
        if (s.id == sessionId) {
          return s.copyWith(
            lastMessageAt: message.timestamp,
            lastMessagePreview: message.text.length > 50
                ? '${message.text.substring(0, 50)}...'
                : message.text,
          );
        }
        return s;
      }).toList(),
    );
  }

  /// Increment unread count for a session.
  Future<void> incrementUnread(String sessionId) async {
    final session = state.sessions.firstWhere(
      (s) => s.id == sessionId,
      orElse: () => throw Exception('Session not found'),
    );

    await _sessionDatasource.updateMetadata(
      sessionId,
      unreadCount: session.unreadCount + 1,
    );

    state = state.copyWith(
      sessions: state.sessions.map((s) {
        if (s.id == sessionId) {
          return s.copyWith(unreadCount: s.unreadCount + 1);
        }
        return s;
      }).toList(),
    );
  }

  /// Clear unread count for a session.
  Future<void> clearUnread(String sessionId) async {
    await _sessionDatasource.updateMetadata(sessionId, unreadCount: 0);

    state = state.copyWith(
      sessions: state.sessions.map((s) {
        if (s.id == sessionId) {
          return s.copyWith(unreadCount: 0);
        }
        return s;
      }).toList(),
    );
  }
}

/// Notifier for chat messages.
class ChatNotifier extends StateNotifier<ChatState> {
  ChatNotifier(
    this._messageDatasource,
    this._sessionDatasource,
    this._sessionManagerService,
  ) : super(const ChatState());

  final MessageLocalDatasource _messageDatasource;
  final SessionLocalDatasource _sessionDatasource;
  final SessionManagerService _sessionManagerService;

  static const int _kReactionKind = 7;
  static const int _kChatMessageKind = 14;
  static const int _kReceiptKind = 15;
  static const int _kTypingKind = 25;

  static const Duration _kTypingExpiry = Duration(seconds: 10);
  static const Duration _kTypingThrottle = Duration(seconds: 3);

  final Map<String, Timer> _typingExpiryTimers = {};
  final Map<String, int> _lastMessageAtMs = {};
  final Map<String, int> _lastTypingSentAtMs = {};

  @override
  void dispose() {
    for (final t in _typingExpiryTimers.values) {
      t.cancel();
    }
    _typingExpiryTimers.clear();
    super.dispose();
  }

  /// Load messages for a session.
  Future<void> loadMessages(String sessionId, {int limit = 50}) async {
    try {
      final messages = await _messageDatasource.getMessagesForSession(
        sessionId,
        limit: limit,
      );
      state = state.copyWith(
        messages: {...state.messages, sessionId: messages},
        error: null,
      );
    } catch (e, st) {
      final appError = AppError.from(e, st);
      state = state.copyWith(error: appError.message);
    }
  }

  /// Load more messages (pagination).
  Future<void> loadMoreMessages(String sessionId, {int limit = 50}) async {
    final currentMessages = state.messages[sessionId] ?? [];
    if (currentMessages.isEmpty) {
      return loadMessages(sessionId, limit: limit);
    }

    try {
      final oldestMessage = currentMessages.first;
      final olderMessages = await _messageDatasource.getMessagesForSession(
        sessionId,
        limit: limit,
        beforeId: oldestMessage.id,
      );

      state = state.copyWith(
        messages: {
          ...state.messages,
          sessionId: [...olderMessages, ...currentMessages],
        },
        error: null,
      );
    } catch (e, st) {
      final appError = AppError.from(e, st);
      state = state.copyWith(error: appError.message);
    }
  }

  /// Add a message optimistically.
  void addMessageOptimistic(ChatMessage message) {
    final sessionId = message.sessionId;
    final currentMessages = state.messages[sessionId] ?? [];

    state = state.copyWith(
      messages: {
        ...state.messages,
        sessionId: [...currentMessages, message],
      },
      sendingStates: {...state.sendingStates, message.id: true},
    );
  }

  /// Send a message.
  Future<void> sendMessage(String sessionId, String text) async {
    // Create optimistic message
    final message = ChatMessage.outgoing(
      sessionId: sessionId,
      text: text,
    );

    // Add to UI immediately
    addMessageOptimistic(message);

    await _sendMessageInternal(message);
  }

  /// Send a queued message (called by OfflineQueueService).
  Future<void> sendQueuedMessage(
    String sessionId,
    String text,
    String messageId,
  ) async {
    // Find existing message or create placeholder
    final existingMessages = state.messages[sessionId] ?? [];
    final existingMessage = existingMessages
        .cast<ChatMessage?>()
        .firstWhere((m) => m?.id == messageId, orElse: () => null);

    if (existingMessage != null) {
      // Update to pending and send
      final pendingMessage = existingMessage.copyWith(status: MessageStatus.pending);
      await _sendMessageInternal(pendingMessage);
    } else {
      // Message not in state, create it
      final message = ChatMessage(
        id: messageId,
        sessionId: sessionId,
        text: text,
        timestamp: DateTime.now(),
        direction: MessageDirection.outgoing,
        status: MessageStatus.pending,
      );
      addMessageOptimistic(message);
      await _sendMessageInternal(message);
    }
  }

  Future<void> _sendMessageInternal(ChatMessage message) async {
    try {
      final session = await _sessionDatasource.getSession(message.sessionId);
      if (session == null) {
        throw const AppError(
          type: AppErrorType.sessionExpired,
          message: 'Session not found. Please start a new conversation.',
          isRetryable: false,
        );
      }

      // Send via session manager (publishes through pubsub bridge)
      final sendResult = await _sessionManagerService.sendTextWithInnerId(
        recipientPubkeyHex: session.recipientPubkeyHex,
        text: message.text,
      );

      // Update session state from manager
      final newState =
          await _sessionManagerService.getActiveSessionState(session.recipientPubkeyHex);
      if (newState != null) {
        await _sessionDatasource.saveSessionState(message.sessionId, newState);
      }

      final outerEventIds = sendResult.outerEventIds;
      final eventId = outerEventIds.isNotEmpty ? outerEventIds.first : null;
      final rumorId = sendResult.innerId.isNotEmpty ? sendResult.innerId : null;

      // Update message with success
      final sentMessage = message.copyWith(
        status: eventId != null ? MessageStatus.sent : MessageStatus.pending,
        eventId: eventId,
        rumorId: rumorId,
      );
      await updateMessage(sentMessage);
    } catch (e, st) {
      // Map to user-friendly error
      final appError = e is AppError ? e : AppError.from(e, st);

      // Update message with failure
      final failedMessage = message.copyWith(status: MessageStatus.failed);
      await updateMessage(failedMessage);
      state = state.copyWith(error: appError.message);

      // Re-throw so queue service knows to retry
      rethrow;
    }
  }

  /// Receive a decrypted message from the session manager.
  Future<ChatMessage?> receiveDecryptedMessage(
    String senderPubkeyHex,
    String content, {
    String? eventId,
    int? createdAt,
  }) async {
    try {
      if (eventId != null && await _messageDatasource.messageExists(eventId)) {
        return null;
      }

      final rumor = NostrRumor.tryParse(content);

      // Legacy fallback: treat decrypted plaintext as a chat message.
      if (rumor == null) {
        final existingSession =
            await _sessionDatasource.getSessionByRecipient(senderPubkeyHex);
        final sessionId = existingSession?.id ?? senderPubkeyHex;

        if (existingSession == null) {
          final session = ChatSession(
            id: sessionId,
            recipientPubkeyHex: senderPubkeyHex,
            createdAt: DateTime.now(),
            isInitiator: false,
          );
          await _sessionDatasource.saveSession(session);
        }

        final reactionPayload = parseReactionPayload(content);
        if (reactionPayload != null) {
          handleIncomingReaction(
            sessionId,
            reactionPayload['messageId'] as String,
            reactionPayload['emoji'] as String,
            senderPubkeyHex,
          );
          return null;
        }

        final timestamp = createdAt != null
            ? DateTime.fromMillisecondsSinceEpoch(createdAt * 1000)
            : DateTime.now();

        final resolvedEventId =
            eventId ?? DateTime.now().microsecondsSinceEpoch.toString();
        final message = ChatMessage.incoming(
          sessionId: sessionId,
          text: content,
          eventId: resolvedEventId,
          rumorId: resolvedEventId,
          timestamp: timestamp,
        );

        await addReceivedMessage(message);
        return message;
      }

      final ownerPubkeyHex = _sessionManagerService.ownerPubkeyHex;
      final peerPubkeyHex = ownerPubkeyHex != null
          ? resolveRumorPeerPubkey(ownerPubkeyHex: ownerPubkeyHex, rumor: rumor)
          : senderPubkeyHex;

      if (peerPubkeyHex == null || peerPubkeyHex.isEmpty) {
        return null;
      }

      // Find or create session by recipient pubkey (peer pubkey).
      final existingSession =
          await _sessionDatasource.getSessionByRecipient(peerPubkeyHex);
      final sessionId = existingSession?.id ?? peerPubkeyHex;

      if (existingSession == null) {
        final session = ChatSession(
          id: sessionId,
          recipientPubkeyHex: peerPubkeyHex,
          createdAt: DateTime.now(),
          isInitiator: false,
        );
        await _sessionDatasource.saveSession(session);
      }

      // Receipt (kind 15): update outgoing message status by stable rumor ids.
      if (rumor.kind == _kReceiptKind) {
        final receiptType = rumor.content;
        final messageIds = getTagValues(rumor.tags, 'e');
        if (messageIds.isEmpty) return null;

        final nextStatus = switch (receiptType) {
          'delivered' => MessageStatus.delivered,
          'seen' => MessageStatus.seen,
          _ => null,
        };
        if (nextStatus == null) return null;

        for (final id in messageIds) {
          await _applyOutgoingStatusByRumorId(id, nextStatus);
        }
        return null;
      }

      // Typing indicator (kind 25)
      if (rumor.kind == _kTypingKind) {
        if (ownerPubkeyHex != null && rumor.pubkey == ownerPubkeyHex) {
          // Ignore self typing events (multi-device sync).
          return null;
        }
        final tsMs = rumorTimestamp(rumor).millisecondsSinceEpoch;
        _setRemoteTyping(sessionId, eventTimestampMs: tsMs);
        return null;
      }

      // Reaction (kind 7) or legacy reaction payload inside kind 14.
      if (rumor.kind == _kReactionKind) {
        final messageId = getFirstTagValue(rumor.tags, 'e');
        if (messageId == null || messageId.isEmpty) return null;
        handleIncomingReaction(sessionId, messageId, rumor.content, rumor.pubkey);
        return null;
      }

      if (rumor.kind != _kChatMessageKind) {
        return null;
      }

      // De-dup using stable inner id.
      if (await _messageDatasource.messageExists(rumor.id)) {
        return null;
      }

      // Some clients send reactions as JSON content in kind 14; keep compatibility.
      final reactionPayload = parseReactionPayload(rumor.content);
      if (reactionPayload != null) {
        handleIncomingReaction(
          sessionId,
          reactionPayload['messageId'] as String,
          reactionPayload['emoji'] as String,
          rumor.pubkey,
        );
        return null;
      }

      final isMine = ownerPubkeyHex != null && rumor.pubkey == ownerPubkeyHex;

      final message = ChatMessage(
        id: rumor.id,
        sessionId: sessionId,
        text: rumor.content,
        timestamp: rumorTimestamp(rumor),
        direction:
            isMine ? MessageDirection.outgoing : MessageDirection.incoming,
        status: isMine ? MessageStatus.sent : MessageStatus.delivered,
        eventId: eventId,
        rumorId: rumor.id,
      );

      _clearRemoteTyping(
        sessionId,
        messageTimestampMs: message.timestamp.millisecondsSinceEpoch,
      );

      await addReceivedMessage(message);

      // Auto-send delivery receipt for incoming messages.
      if (!isMine) {
        await _sessionManagerService.sendReceipt(
          recipientPubkeyHex: peerPubkeyHex,
          receiptType: 'delivered',
          messageIds: [rumor.id],
        );
      }

      return message;
    } catch (e, st) {
      final appError = AppError.from(e, st);
      state = state.copyWith(error: appError.message);
      return null;
    }
  }

  Future<void> markSessionSeen(String sessionId) async {
    final session = await _sessionDatasource.getSession(sessionId);
    if (session == null) return;

    final inState = state.messages[sessionId];
    final messages = (inState == null || inState.isEmpty)
        ? await _messageDatasource.getMessagesForSession(sessionId, limit: 200)
        : inState;

    final toMark = messages
        .where((m) => m.isIncoming && m.status != MessageStatus.seen)
        .toList();
    if (toMark.isEmpty) return;

    final rumorIds = toMark
        .map((m) => m.rumorId ?? m.id)
        .where((id) => id.isNotEmpty)
        .toSet();

    if (rumorIds.isNotEmpty) {
      await _sessionManagerService.sendReceipt(
        recipientPubkeyHex: session.recipientPubkeyHex,
        receiptType: 'seen',
        messageIds: rumorIds.toList(),
      );

      for (final id in rumorIds) {
        await _messageDatasource.updateIncomingStatusByRumorId(
          id,
          MessageStatus.seen,
        );
      }
    }

    // Update in-memory state (only for messages currently loaded into state).
    final current = state.messages[sessionId];
    if (current == null) return;

    final updated = current.map((m) {
      if (!m.isIncoming) return m;
      final id = m.rumorId ?? m.id;
      if (!rumorIds.contains(id)) return m;
      if (!shouldAdvanceStatus(m.status, MessageStatus.seen)) return m;
      return m.copyWith(status: MessageStatus.seen);
    }).toList();

    state = state.copyWith(
      messages: {...state.messages, sessionId: updated},
    );
  }

  Future<void> notifyTyping(String sessionId) async {
    final nowMs = DateTime.now().millisecondsSinceEpoch;
    final last = _lastTypingSentAtMs[sessionId] ?? 0;
    if (nowMs - last < _kTypingThrottle.inMilliseconds) return;

    _lastTypingSentAtMs[sessionId] = nowMs;

    final session = await _sessionDatasource.getSession(sessionId);
    if (session == null) return;

    await _sessionManagerService.sendTyping(
      recipientPubkeyHex: session.recipientPubkeyHex,
    );
  }

  void _setRemoteTyping(String sessionId, {int? eventTimestampMs}) {
    if (eventTimestampMs != null) {
      final lastMsg = _lastMessageAtMs[sessionId];
      if (lastMsg != null && eventTimestampMs <= lastMsg) return;
    }

    _typingExpiryTimers[sessionId]?.cancel();

    state = state.copyWith(
      typingStates: {...state.typingStates, sessionId: true},
    );

    _typingExpiryTimers[sessionId] = Timer(_kTypingExpiry, () {
      _typingExpiryTimers.remove(sessionId);
      final next = {...state.typingStates}..remove(sessionId);
      state = state.copyWith(typingStates: next);
    });
  }

  void _clearRemoteTyping(String sessionId, {int? messageTimestampMs}) {
    if (messageTimestampMs != null) {
      final prev = _lastMessageAtMs[sessionId] ?? 0;
      _lastMessageAtMs[sessionId] =
          messageTimestampMs > prev ? messageTimestampMs : prev;
    }

    _typingExpiryTimers[sessionId]?.cancel();
    _typingExpiryTimers.remove(sessionId);

    if (!state.typingStates.containsKey(sessionId)) return;
    final next = {...state.typingStates}..remove(sessionId);
    state = state.copyWith(typingStates: next);
  }

  Future<void> _applyOutgoingStatusByRumorId(
    String rumorId,
    MessageStatus nextStatus,
  ) async {
    await _messageDatasource.updateOutgoingStatusByRumorId(rumorId, nextStatus);

    var changed = false;
    final updatedBySession = <String, List<ChatMessage>>{};

    for (final entry in state.messages.entries) {
      final sessionId = entry.key;
      final updated = entry.value.map((m) {
        if (!m.isOutgoing) return m;
        if (m.rumorId != rumorId && m.id != rumorId) return m;
        if (!shouldAdvanceStatus(m.status, nextStatus)) return m;
        changed = true;
        return m.copyWith(status: nextStatus);
      }).toList();
      updatedBySession[sessionId] = updated;
    }

    if (!changed) return;
    state = state.copyWith(messages: updatedBySession);
  }

  /// Update a message (e.g., after sending succeeds).
  Future<void> updateMessage(ChatMessage message) async {
    await _messageDatasource.saveMessage(message);

    final sessionId = message.sessionId;
    final currentMessages = state.messages[sessionId] ?? [];

    state = state.copyWith(
      messages: {
        ...state.messages,
        sessionId: currentMessages
            .map((m) => m.id == message.id ? message : m)
            .toList(),
      },
      sendingStates: {...state.sendingStates}..remove(message.id),
    );
  }

  /// Add a received message.
  Future<void> addReceivedMessage(ChatMessage message) async {
    // Check if message already exists
    final dedupeKey = message.rumorId ?? message.eventId ?? message.id;
    if (await _messageDatasource.messageExists(dedupeKey)) return;

    await _messageDatasource.saveMessage(message);

    final sessionId = message.sessionId;
    final currentMessages = state.messages[sessionId] ?? [];

    state = state.copyWith(
      messages: {
        ...state.messages,
        sessionId: [...currentMessages, message],
      },
    );
  }

  /// Send a reaction to a message.
  /// Note: messageId here is the internal message ID, we need to use eventId for the reaction payload
  Future<void> sendReaction(String sessionId, String messageId, String emoji, String myPubkey) async {
    try {
      // Find the message to get its eventId (Nostr event ID)
      final messages = state.messages[sessionId] ?? [];
      final message = messages.firstWhere(
        (m) => m.id == messageId,
        orElse: () => throw const AppError(
          type: AppErrorType.unknown,
          message: 'Message not found',
          isRetryable: false,
        ),
      );

      // Use eventId for the reaction - this is what iris-chat expects
      final reactionMessageId = message.eventId ?? message.id;

      // Send reaction as JSON payload
      final payload = jsonEncode({
        'type': 'reaction',
        'messageId': reactionMessageId,
        'emoji': emoji,
      });

      final session = await _sessionDatasource.getSession(sessionId);
      if (session == null) {
        throw const AppError(
          type: AppErrorType.sessionExpired,
          message: 'Session not found. Please start a new conversation.',
          isRetryable: false,
        );
      }

      await _sessionManagerService.sendText(
        recipientPubkeyHex: session.recipientPubkeyHex,
        text: payload,
      );

      // Update session state from manager
      final newState =
          await _sessionManagerService.getActiveSessionState(session.recipientPubkeyHex);
      if (newState != null) {
        await _sessionDatasource.saveSessionState(sessionId, newState);
      }

      // Update reaction optimistically (use internal ID for state management)
      _applyReaction(sessionId, messageId, emoji, myPubkey);
    } catch (e, st) {
      final appError = e is AppError ? e : AppError.from(e, st);
      state = state.copyWith(error: appError.message);
    }
  }

  /// Handle incoming reaction.
  void handleIncomingReaction(String sessionId, String messageId, String emoji, String fromPubkey) {
    _applyReaction(sessionId, messageId, emoji, fromPubkey);
  }

  /// Apply a reaction to a message (used for both sent and received reactions).
  /// messageId can be either internal id or eventId (Nostr event ID)
  void _applyReaction(String sessionId, String messageId, String emoji, String pubkey) {
    final currentMessages = state.messages[sessionId] ?? [];
    // Match by internal id first, then by eventId
    var messageIndex = currentMessages.indexWhere((m) => m.id == messageId);
    if (messageIndex == -1) {
      messageIndex = currentMessages.indexWhere((m) => m.eventId == messageId);
    }
    if (messageIndex == -1) {
      messageIndex = currentMessages.indexWhere((m) => m.rumorId == messageId);
    }
    if (messageIndex == -1) return;

    final message = currentMessages[messageIndex];

    // Create updated reactions - remove user from any existing reactions first
    final reactions = <String, List<String>>{};
    for (final entry in message.reactions.entries) {
      final filtered = entry.value.where((u) => u != pubkey).toList();
      if (filtered.isNotEmpty) {
        reactions[entry.key] = filtered;
      }
    }

    // Add user to new reaction
    reactions[emoji] = [...(reactions[emoji] ?? []), pubkey];

    // Update message
    final updatedMessage = message.copyWith(reactions: reactions);
    final updatedMessages = [...currentMessages];
    updatedMessages[messageIndex] = updatedMessage;

    state = state.copyWith(
      messages: {...state.messages, sessionId: updatedMessages},
    );

    // Save to database
    _messageDatasource.saveMessage(updatedMessage);
  }

  /// Check if content is a reaction payload and return parsed data.
  static Map<String, dynamic>? parseReactionPayload(String content) {
    try {
      final parsed = jsonDecode(content) as Map<String, dynamic>;
      if (parsed['type'] == 'reaction' && parsed['messageId'] != null && parsed['emoji'] != null) {
        return parsed;
      }
    } catch (_) {}
    return null;
  }

  /// Update message status.
  Future<void> updateMessageStatus(
    String messageId,
    MessageStatus status,
  ) async {
    await _messageDatasource.updateMessageStatus(messageId, status);

    state = state.copyWith(
      messages: state.messages.map((sessionId, messages) {
        return MapEntry(
          sessionId,
          messages.map((m) {
            if (m.id == messageId) {
              return m.copyWith(status: status);
            }
            return m;
          }).toList(),
        );
      }),
    );
  }

  /// Clear error state.
  void clearError() {
    state = state.copyWith(error: null);
  }
}

// Providers

final databaseServiceProvider = Provider<DatabaseService>((ref) {
  return DatabaseService();
});

final sessionDatasourceProvider = Provider<SessionLocalDatasource>((ref) {
  final db = ref.watch(databaseServiceProvider);
  return SessionLocalDatasource(db);
});

final messageDatasourceProvider = Provider<MessageLocalDatasource>((ref) {
  final db = ref.watch(databaseServiceProvider);
  return MessageLocalDatasource(db);
});

final chatRepositoryProvider = Provider<ChatRepository>((ref) {
  final sessionDatasource = ref.watch(sessionDatasourceProvider);
  final messageDatasource = ref.watch(messageDatasourceProvider);
  final nostrService = ref.watch(nostrServiceProvider);

  return ChatRepositoryImpl(
    sessionDatasource: sessionDatasource,
    messageDatasource: messageDatasource,
    nostrService: nostrService,
  );
});

final sessionStateProvider =
    StateNotifierProvider<SessionNotifier, SessionState>((ref) {
  final datasource = ref.watch(sessionDatasourceProvider);
  final profileService = ref.watch(profileServiceProvider);
  return SessionNotifier(datasource, profileService);
});

final chatStateProvider = StateNotifierProvider<ChatNotifier, ChatState>((ref) {
  final messageDatasource = ref.watch(messageDatasourceProvider);
  final sessionDatasource = ref.watch(sessionDatasourceProvider);
  final sessionManagerService = ref.watch(sessionManagerServiceProvider);
  return ChatNotifier(messageDatasource, sessionDatasource, sessionManagerService);
});

/// Provider for messages in a specific session.
/// Performance: Uses select() to only rebuild when messages for this specific session change.
final sessionMessagesProvider =
    Provider.family<List<ChatMessage>, String>((ref, sessionId) {
  // Use select to only watch messages for this specific session
  return ref.watch(
    chatStateProvider.select((state) => state.messages[sessionId] ?? []),
  );
});

/// Provider for message count in a specific session.
/// Useful for UI that only needs to know if there are messages without watching the full list.
final sessionMessageCountProvider =
    Provider.family<int, String>((ref, sessionId) {
  return ref.watch(
    chatStateProvider.select((state) => state.messages[sessionId]?.length ?? 0),
  );
});

/// Provider for checking if a session has messages.
/// More efficient than watching the full message list when you only need a boolean.
final sessionHasMessagesProvider =
    Provider.family<bool, String>((ref, sessionId) {
  return ref.watch(
    chatStateProvider.select(
      (state) => state.messages[sessionId]?.isNotEmpty ?? false,
    ),
  );
});

import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:freezed_annotation/freezed_annotation.dart';

import '../../core/services/database_service.dart';
import '../../core/services/error_service.dart';
import '../../core/services/profile_service.dart';
import '../../core/services/session_manager_service.dart';
import '../../core/utils/nostr_rumor.dart';
import '../../features/chat/data/datasources/group_local_datasource.dart';
import '../../features/chat/data/datasources/group_message_local_datasource.dart';
import '../../features/chat/data/datasources/message_local_datasource.dart';
import '../../features/chat/data/datasources/session_local_datasource.dart';
import '../../features/chat/data/repositories/chat_repository_impl.dart';
import '../../features/chat/domain/models/group.dart';
import '../../features/chat/domain/models/message.dart';
import '../../features/chat/domain/models/session.dart';
import '../../features/chat/domain/repositories/chat_repository.dart';
import '../../features/chat/domain/utils/chat_settings.dart';
import '../../features/chat/domain/utils/group_metadata.dart';
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

/// State for group chats.
@freezed
abstract class GroupState with _$GroupState {
  const factory GroupState({
    @Default([]) List<ChatGroup> groups,
    @Default(false) bool isLoading,
    @Default({}) Map<String, List<ChatMessage>> messages,
    @Default({}) Map<String, bool> typingStates,
    String? error,
  }) = _GroupState;
}

/// Notifier for session state.
class SessionNotifier extends StateNotifier<SessionState> {
  SessionNotifier(this._sessionDatasource, this._profileService)
    : super(const SessionState());

  final SessionLocalDatasource _sessionDatasource;
  final ProfileService _profileService;

  void _upsertSessionInState(ChatSession session) {
    // Avoid duplicate sessions in memory when the same session is "added" twice
    // (e.g., relay replays, reconnects, or overlapping flows).
    final existingIndex = state.sessions.indexWhere((s) => s.id == session.id);
    if (existingIndex == -1) {
      state = state.copyWith(sessions: [session, ...state.sessions]);
      return;
    }

    final updated = [...state.sessions];
    updated[existingIndex] = session;
    // Keep most-recent sessions at the top.
    if (existingIndex != 0) {
      updated.removeAt(existingIndex);
      updated.insert(0, session);
    }
    state = state.copyWith(sessions: updated);
  }

  /// Load all sessions from storage.
  Future<void> loadSessions() async {
    state = state.copyWith(isLoading: true, error: null);
    try {
      final sessions = await _sessionDatasource.getAllSessions();
      state = state.copyWith(sessions: sessions, isLoading: false);

      // Fetch profiles for all recipients without names
      unawaited(_fetchMissingProfiles(sessions).catchError((_, __) {}));
    } catch (e, st) {
      final appError = AppError.from(e, st);
      state = state.copyWith(isLoading: false, error: appError.message);
    }
  }

  /// Fetch profiles for sessions without recipient names.
  Future<void> _fetchMissingProfiles(List<ChatSession> sessions) async {
    try {
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
    } catch (_) {
      // Best-effort background task; ignore errors to avoid noisy unhandled futures.
    }
  }

  /// Update recipient name for sessions with a given pubkey.
  Future<void> updateRecipientName(String pubkey, String name) async {
    final updatedSessions = <ChatSession>[];

    for (final session in state.sessions) {
      if (session.recipientPubkeyHex == pubkey &&
          session.recipientName != name) {
        final updated = session.copyWith(recipientName: name);
        unawaited(() async {
          try {
            await _sessionDatasource.saveSession(updated);
          } catch (_) {}
        }());
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
    _upsertSessionInState(session);
    unawaited(() async {
      try {
        await _sessionDatasource.saveSession(session);
      } catch (_) {}
    }());
  }

  /// Ensure a session exists for [recipientPubkeyHex] and return it.
  ///
  /// This is used for "public chat links" that only contain a Nostr identity
  /// (npub/nprofile) rather than an Iris invite payload.
  Future<ChatSession> ensureSessionForRecipient(
    String recipientPubkeyHex,
  ) async {
    final normalized = recipientPubkeyHex.toLowerCase().trim();

    // Fast-path: if already in memory, don't touch the DB (avoids UI stalls on locked DB).
    for (final s in state.sessions) {
      if (s.id == normalized || s.recipientPubkeyHex == normalized) {
        return s;
      }
    }

    // Create a placeholder session immediately so the UI can navigate.
    // Persist with INSERT-IF-ABSENT to avoid overwriting an existing session's
    // ratchet state/metadata if the DB already contains it.
    final session = ChatSession(
      id: normalized,
      recipientPubkeyHex: normalized,
      createdAt: DateTime.now(),
    );

    _upsertSessionInState(session);
    unawaited(() async {
      try {
        await _sessionDatasource.insertSessionIfAbsent(session);
      } catch (_) {}
    }());

    return session;
  }

  /// Update a session.
  Future<void> updateSession(ChatSession session) async {
    state = state.copyWith(
      sessions: state.sessions
          .map((s) => s.id == session.id ? session : s)
          .toList(),
    );
    unawaited(() async {
      try {
        await _sessionDatasource.saveSession(session);
      } catch (_) {}
    }());
  }

  /// Update per-chat disappearing messages timer (in seconds).
  Future<void> setMessageTtlSeconds(
    String sessionId,
    int? messageTtlSeconds,
  ) async {
    final normalized = (messageTtlSeconds != null && messageTtlSeconds > 0)
        ? messageTtlSeconds
        : null;

    // Fast-path: update in-memory session if present.
    final index = state.sessions.indexWhere((s) => s.id == sessionId);
    if (index != -1) {
      final current = state.sessions[index];
      if (current.messageTtlSeconds == normalized) return;
      final updated = current.copyWith(messageTtlSeconds: normalized);
      _upsertSessionInState(updated);
      unawaited(() async {
        try {
          await _sessionDatasource.saveSession(updated);
        } catch (_) {}
      }());
      return;
    }

    // Fallback: load from DB and upsert.
    final existing = await _sessionDatasource.getSession(sessionId);
    if (existing == null) return;
    final updated = existing.copyWith(messageTtlSeconds: normalized);
    _upsertSessionInState(updated);
    unawaited(() async {
      try {
        await _sessionDatasource.saveSession(updated);
      } catch (_) {}
    }());
  }

  /// Reload a session from DB and upsert into state.
  Future<void> refreshSession(String sessionId) async {
    try {
      final s = await _sessionDatasource.getSession(sessionId);
      if (s == null) return;
      _upsertSessionInState(s);
    } catch (_) {}
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
    final index = state.sessions.indexWhere((s) => s.id == sessionId);
    if (index == -1) return;

    final current = state.sessions[index];
    final updatedSession = current.copyWith(
      lastMessageAt: message.timestamp,
      lastMessagePreview: message.text.length > 50
          ? '${message.text.substring(0, 50)}...'
          : message.text,
    );

    final next = [...state.sessions];
    next[index] = updatedSession;
    if (index != 0) {
      next.removeAt(index);
      next.insert(0, updatedSession);
    }

    state = state.copyWith(sessions: next);

    unawaited(() async {
      try {
        await _sessionDatasource.updateMetadata(
          sessionId,
          lastMessageAt: message.timestamp,
          lastMessagePreview: message.text.length > 50
              ? '${message.text.substring(0, 50)}...'
              : message.text,
        );
      } catch (_) {}
    }());
  }

  /// Increment unread count for a session.
  Future<void> incrementUnread(String sessionId) async {
    final session = state.sessions.firstWhere(
      (s) => s.id == sessionId,
      orElse: () => throw Exception('Session not found'),
    );

    state = state.copyWith(
      sessions: state.sessions.map((s) {
        if (s.id == sessionId) {
          return s.copyWith(unreadCount: s.unreadCount + 1);
        }
        return s;
      }).toList(),
    );

    unawaited(() async {
      try {
        await _sessionDatasource.updateMetadata(
          sessionId,
          unreadCount: session.unreadCount + 1,
        );
      } catch (_) {}
    }());
  }

  /// Clear unread count for a session.
  Future<void> clearUnread(String sessionId) async {
    state = state.copyWith(
      sessions: state.sessions.map((s) {
        if (s.id == sessionId) {
          return s.copyWith(unreadCount: 0);
        }
        return s;
      }).toList(),
    );

    unawaited(() async {
      try {
        await _sessionDatasource.updateMetadata(sessionId, unreadCount: 0);
      } catch (_) {}
    }());
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
  final Map<String, int> _lastTypingSentAtMs = {};
  final Map<String, int> _lastMessageAtMs = {};

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

  /// Remove expired messages from in-memory state.
  ///
  /// Persistent storage cleanup is handled elsewhere; this only updates UI state.
  void purgeExpiredFromState(int nowSeconds) {
    if (state.messages.isEmpty) return;

    var changed = false;
    final updatedBySession = <String, List<ChatMessage>>{};

    for (final entry in state.messages.entries) {
      final filtered = entry.value
          .where((m) => m.expiresAt == null || m.expiresAt! > nowSeconds)
          .toList();
      if (filtered.length != entry.value.length) changed = true;
      updatedBySession[entry.key] = filtered;
    }

    if (!changed) return;
    state = state.copyWith(messages: updatedBySession);
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
    final message = ChatMessage.outgoing(sessionId: sessionId, text: text);

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
    final existingMessage = existingMessages.cast<ChatMessage?>().firstWhere(
      (m) => m?.id == messageId,
      orElse: () => null,
    );

    if (existingMessage != null) {
      // Update to pending and send
      final pendingMessage = existingMessage.copyWith(
        status: MessageStatus.pending,
      );
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
    int? expiresAtSeconds;
    try {
      final session = await _sessionDatasource.getSession(message.sessionId);
      if (session == null) {
        throw const AppError(
          type: AppErrorType.sessionExpired,
          message: 'Session not found. Please start a new conversation.',
          isRetryable: false,
        );
      }

      final ttlSeconds = session.messageTtlSeconds;
      expiresAtSeconds = (ttlSeconds != null && ttlSeconds > 0)
          ? (DateTime.now().millisecondsSinceEpoch ~/ 1000 + ttlSeconds)
          : null;

      // Send via session manager (publishes through pubsub bridge)
      final sendResult = await _sessionManagerService.sendTextWithInnerId(
        recipientPubkeyHex: session.recipientPubkeyHex,
        text: message.text,
        expiresAtSeconds: expiresAtSeconds,
      );

      // Update session state from manager
      final newState = await _sessionManagerService.getActiveSessionState(
        session.recipientPubkeyHex,
      );
      if (newState != null) {
        await _sessionDatasource.saveSessionState(message.sessionId, newState);
      }

      final outerEventIds = sendResult.outerEventIds;
      final eventId = outerEventIds.isNotEmpty ? outerEventIds.first : null;
      final rumorId = sendResult.innerId.isNotEmpty ? sendResult.innerId : null;

      // Update message with success
      final sentMessage = message.copyWith(
        // `outerEventIds` can be empty even when the send succeeded (queued/offline
        // publishes, relays without ACKs, etc). Treat a successful send call as
        // "sent" and rely on receipts / self-echo backfill to advance further.
        status: MessageStatus.sent,
        eventId: eventId,
        rumorId: rumorId,
        expiresAt: expiresAtSeconds,
      );
      await updateMessage(sentMessage);
    } catch (e, st) {
      // Map to user-friendly error
      final appError = e is AppError ? e : AppError.from(e, st);

      // Update message with failure
      final failedMessage = message.copyWith(
        status: MessageStatus.failed,
        expiresAt: expiresAtSeconds ?? message.expiresAt,
      );
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
        final existingSession = await _sessionDatasource.getSessionByRecipient(
          senderPubkeyHex,
        );
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
      final existingSession = await _sessionDatasource.getSessionByRecipient(
        peerPubkeyHex,
      );
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
        handleIncomingReaction(
          sessionId,
          messageId,
          rumor.content,
          rumor.pubkey,
        );
        return null;
      }

      if (rumor.kind != _kChatMessageKind) {
        return null;
      }

      final isMine = ownerPubkeyHex != null && rumor.pubkey == ownerPubkeyHex;

      // De-dup using stable inner id.
      if (await _messageDatasource.messageExists(rumor.id)) {
        // When we receive a relay echo / self-copy of our own outgoing message,
        // use it to backfill the outer event id so reactions can reference it.
        if (isMine && eventId != null && eventId.isNotEmpty) {
          _backfillOutgoingEventId(rumor.id, eventId);
        }
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

      final nowSeconds = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      final expiresAtSeconds = getExpirationTimestampSeconds(rumor.tags);
      if (expiresAtSeconds != null && expiresAtSeconds <= nowSeconds) {
        // Ignore already-expired messages; they may still be delivered by relays,
        // but clients should not surface them.
        return null;
      }

      final message = ChatMessage(
        id: rumor.id,
        sessionId: sessionId,
        text: rumor.content,
        timestamp: rumorTimestamp(rumor),
        expiresAt: expiresAtSeconds,
        direction: isMine
            ? MessageDirection.outgoing
            : MessageDirection.incoming,
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

    state = state.copyWith(messages: {...state.messages, sessionId: updated});
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
      _lastMessageAtMs[sessionId] = messageTimestampMs > prev
          ? messageTimestampMs
          : prev;
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

  void _backfillOutgoingEventId(String rumorId, String eventId) {
    // Update UI state immediately; persist in background.
    var changed = false;
    final updatedBySession = <String, List<ChatMessage>>{};

    for (final entry in state.messages.entries) {
      final sessionId = entry.key;
      final updated = entry.value.map((m) {
        if (!m.isOutgoing) return m;
        if (m.rumorId != rumorId && m.id != rumorId) return m;

        final nextEventId = (m.eventId == null || m.eventId!.isEmpty)
            ? eventId
            : m.eventId;
        final nextStatus = shouldAdvanceStatus(m.status, MessageStatus.sent)
            ? MessageStatus.sent
            : m.status;

        if (nextEventId == m.eventId && nextStatus == m.status) return m;
        changed = true;
        return m.copyWith(eventId: nextEventId, status: nextStatus);
      }).toList();
      updatedBySession[sessionId] = updated;
    }

    if (changed) {
      state = state.copyWith(messages: updatedBySession);
    }

    unawaited(() async {
      try {
        await _messageDatasource.updateOutgoingEventIdByRumorId(
          rumorId,
          eventId,
        );
      } catch (_) {}
    }());
  }

  /// Update a message (e.g., after sending succeeds).
  Future<void> updateMessage(ChatMessage message) async {
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

    // Persist in background so UI doesn't stall on a locked DB.
    unawaited(() async {
      try {
        await _messageDatasource.saveMessage(message);
      } catch (_) {}
    }());
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
  Future<void> sendReaction(
    String sessionId,
    String messageId,
    String emoji,
    String myPubkey,
  ) async {
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

      // Use the outer Nostr event id when available. Fall back to the stable inner id
      // (rumor id) rather than the local UI id.
      final reactionMessageId =
          (message.eventId != null && message.eventId!.isNotEmpty)
          ? message.eventId!
          : (message.rumorId != null && message.rumorId!.isNotEmpty)
          ? message.rumorId!
          : null;
      if (reactionMessageId == null) {
        throw const AppError(
          type: AppErrorType.unknown,
          message:
              'Message not yet ready for reactions. Try again in a moment.',
          isRetryable: true,
        );
      }

      final session = await _sessionDatasource.getSession(sessionId);
      if (session == null) {
        throw const AppError(
          type: AppErrorType.sessionExpired,
          message: 'Session not found. Please start a new conversation.',
          isRetryable: false,
        );
      }

      await _sessionManagerService.sendReaction(
        recipientPubkeyHex: session.recipientPubkeyHex,
        messageId: reactionMessageId,
        emoji: emoji,
      );

      // Update session state from manager
      final newState = await _sessionManagerService.getActiveSessionState(
        session.recipientPubkeyHex,
      );
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

  /// Send a 1:1 "chat-settings" rumor (kind 10448) to coordinate disappearing messages.
  ///
  /// This does not update local state; callers should persist `messageTtlSeconds`
  /// on the session separately (so sending can apply the setting immediately).
  Future<void> sendChatSettingsSignal(
    String sessionId,
    int? messageTtlSeconds,
  ) async {
    try {
      final session = await _sessionDatasource.getSession(sessionId);
      if (session == null) {
        throw const AppError(
          type: AppErrorType.sessionExpired,
          message: 'Session not found. Please start a new conversation.',
          isRetryable: false,
        );
      }

      final normalized = (messageTtlSeconds != null && messageTtlSeconds > 0)
          ? messageTtlSeconds
          : null;
      final content = buildChatSettingsContent(messageTtlSeconds: normalized);

      // Required for self-sync/outgoing copies so we can resolve the peer from the rumor.
      final tagsJson = jsonEncode([
        ['p', session.recipientPubkeyHex],
      ]);

      await _sessionManagerService.sendEventWithInnerId(
        recipientPubkeyHex: session.recipientPubkeyHex,
        kind: kChatSettingsKind,
        content: content,
        tagsJson: tagsJson,
        createdAtSeconds: DateTime.now().millisecondsSinceEpoch ~/ 1000,
      );

      final newState = await _sessionManagerService.getActiveSessionState(
        session.recipientPubkeyHex,
      );
      if (newState != null) {
        await _sessionDatasource.saveSessionState(sessionId, newState);
      }
    } catch (e, st) {
      final appError = e is AppError ? e : AppError.from(e, st);
      state = state.copyWith(error: appError.message);
    }
  }

  /// Handle incoming reaction.
  void handleIncomingReaction(
    String sessionId,
    String messageId,
    String emoji,
    String fromPubkey,
  ) {
    _applyReaction(sessionId, messageId, emoji, fromPubkey);
  }

  /// Apply a reaction to a message (used for both sent and received reactions).
  /// messageId can be either internal id or eventId (Nostr event ID)
  void _applyReaction(
    String sessionId,
    String messageId,
    String emoji,
    String pubkey,
  ) {
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

    // Save to database in background (DB can be locked; don't crash/log-spam).
    unawaited(() async {
      try {
        await _messageDatasource.saveMessage(updatedMessage);
      } catch (_) {}
    }());
  }

  /// Check if content is a reaction payload and return parsed data.
  static Map<String, dynamic>? parseReactionPayload(String content) {
    try {
      final parsed = jsonDecode(content) as Map<String, dynamic>;
      if (parsed['type'] == 'reaction' &&
          parsed['messageId'] != null &&
          parsed['emoji'] != null) {
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

class _PendingGroupEvent {
  const _PendingGroupEvent({
    required this.rumorId,
    required this.rumorJson,
    required this.receivedAtMs,
    this.eventId,
  });

  final String rumorId;
  final String rumorJson;
  final int receivedAtMs;
  final String? eventId;
}

/// Notifier for group chats and group messages.
class GroupNotifier extends StateNotifier<GroupState> {
  GroupNotifier(
    this._groupDatasource,
    this._groupMessageDatasource,
    this._sessionManagerService,
  ) : super(const GroupState());

  final GroupLocalDatasource _groupDatasource;
  final GroupMessageLocalDatasource _groupMessageDatasource;
  final SessionManagerService _sessionManagerService;

  static const int _kGroupMetadataKind = kGroupMetadataKind;
  static const int _kChatMessageKind = 14;
  static const int _kReactionKind = 7;
  static const int _kTypingKind = 25;

  static const Duration _kTypingExpiry = Duration(seconds: 10);
  static const Duration _kTypingThrottle = Duration(seconds: 3);

  // Queue events that arrive before the group's metadata.
  final Map<String, List<_PendingGroupEvent>> _pendingByGroupId = {};
  static const int _kMaxPendingPerGroup = 50;
  static const Duration _kPendingMaxAge = Duration(minutes: 5);

  // Dedupe inner rumor ids (bounded).
  final Map<String, int> _seenRumorAtMs = {};
  static const int _kMaxSeenRumors = 10000;

  final Map<String, Timer> _typingExpiryTimers = {};
  final Map<String, int> _lastTypingSentAtMs = {};

  @override
  void dispose() {
    for (final t in _typingExpiryTimers.values) {
      t.cancel();
    }
    _typingExpiryTimers.clear();
    super.dispose();
  }

  String? _myPubkeyHex() => _sessionManagerService.ownerPubkeyHex;

  Future<void> loadGroups() async {
    state = state.copyWith(isLoading: true, error: null);
    try {
      final groups = await _groupDatasource.getAllGroups();
      state = state.copyWith(groups: groups, isLoading: false);
    } catch (e, st) {
      final appError = AppError.from(e, st);
      state = state.copyWith(isLoading: false, error: appError.message);
    }
  }

  Future<void> loadGroupMessages(String groupId, {int limit = 200}) async {
    try {
      final messages = await _groupMessageDatasource.getMessagesForGroup(
        groupId,
        limit: limit,
      );
      state = state.copyWith(
        messages: {...state.messages, groupId: messages},
        error: null,
      );
    } catch (e, st) {
      final appError = AppError.from(e, st);
      state = state.copyWith(error: appError.message);
    }
  }

  Future<ChatGroup?> getGroup(String groupId) async {
    final inState = state.groups.cast<ChatGroup?>().firstWhere(
      (g) => g?.id == groupId,
      orElse: () => null,
    );
    if (inState != null) return inState;
    return _groupDatasource.getGroup(groupId);
  }

  /// Reload a group from storage and merge it into state.
  Future<void> refreshGroup(String groupId) async {
    try {
      final g = await _groupDatasource.getGroup(groupId);
      if (g == null) return;

      final idx = state.groups.indexWhere((e) => e.id == groupId);
      if (idx == -1) {
        state = state.copyWith(groups: [g, ...state.groups]);
        return;
      }

      final next = [...state.groups];
      next[idx] = g;
      state = state.copyWith(groups: next);
    } catch (_) {}
  }

  /// Remove expired group messages from in-memory state.
  ///
  /// Persistent storage cleanup is handled elsewhere; this only updates UI state.
  void purgeExpiredFromState(int nowSeconds) {
    if (state.messages.isEmpty) return;

    var changed = false;
    final updatedByGroup = <String, List<ChatMessage>>{};

    for (final entry in state.messages.entries) {
      final filtered = entry.value
          .where((m) => m.expiresAt == null || m.expiresAt! > nowSeconds)
          .toList();
      if (filtered.length != entry.value.length) changed = true;
      updatedByGroup[entry.key] = filtered;
    }

    if (!changed) return;
    state = state.copyWith(messages: updatedByGroup);
  }

  Future<String?> createGroup({
    required String name,
    required List<String> memberPubkeysHex,
  }) async {
    final myPubkeyHex = _myPubkeyHex();
    if (myPubkeyHex == null || myPubkeyHex.isEmpty) {
      state = state.copyWith(error: 'Not logged in');
      return null;
    }

    try {
      final group = createGroupData(
        name: name.trim(),
        creatorPubkeyHex: myPubkeyHex,
        memberPubkeysHex: memberPubkeysHex,
      );

      // Persist and update UI.
      await _groupDatasource.saveGroup(group);
      state = state.copyWith(
        groups: [group, ...state.groups.where((g) => g.id != group.id)],
        error: null,
      );

      // Fan-out group metadata (kind 40) to members.
      await _fanOutGroupEvent(
        group: group,
        kind: _kGroupMetadataKind,
        content: buildGroupMetadataContent(group),
        tags: [
          [kGroupTagName, group.id],
        ],
      );

      return group.id;
    } catch (e, st) {
      final appError = AppError.from(e, st);
      state = state.copyWith(error: appError.message);
      return null;
    }
  }

  Future<void> acceptGroupInvitation(String groupId) async {
    try {
      final group = await getGroup(groupId);
      if (group == null) return;
      final updated = group.copyWith(accepted: true);
      await _groupDatasource.saveGroup(updated);
      state = state.copyWith(
        groups: state.groups.map((g) => g.id == groupId ? updated : g).toList(),
      );
    } catch (e, st) {
      final appError = AppError.from(e, st);
      state = state.copyWith(error: appError.message);
    }
  }

  Future<void> renameGroup(String groupId, String name) async {
    final trimmed = name.trim();
    if (trimmed.isEmpty) return;

    final group = await getGroup(groupId);
    if (group == null) return;

    final myPubkeyHex = _myPubkeyHex();
    if (myPubkeyHex == null || myPubkeyHex.isEmpty) {
      state = state.copyWith(error: 'Not logged in');
      return;
    }
    if (!isGroupAdmin(group, myPubkeyHex)) {
      state = state.copyWith(error: 'Only group admins can edit the group.');
      return;
    }

    if (group.name == trimmed) return;

    try {
      final updated = group.copyWith(name: trimmed);
      await _groupDatasource.saveGroup(updated);
      state = state.copyWith(
        groups: state.groups.map((g) => g.id == groupId ? updated : g).toList(),
        error: null,
      );

      await _fanOutGroupEvent(
        group: updated,
        kind: _kGroupMetadataKind,
        content: buildGroupMetadataContent(updated),
        tags: [
          [kGroupTagName, updated.id],
        ],
      );
    } catch (e, st) {
      final appError = AppError.from(e, st);
      state = state.copyWith(error: appError.message);
    }
  }

  Future<void> addGroupMembers(
    String groupId,
    List<String> memberPubkeysHex,
  ) async {
    if (memberPubkeysHex.isEmpty) return;

    final group = await getGroup(groupId);
    if (group == null) return;

    final myPubkeyHex = _myPubkeyHex();
    if (myPubkeyHex == null || myPubkeyHex.isEmpty) {
      state = state.copyWith(error: 'Not logged in');
      return;
    }
    if (!isGroupAdmin(group, myPubkeyHex)) {
      state = state.copyWith(error: 'Only group admins can edit the group.');
      return;
    }

    final toAdd = <String>[];
    final seen = <String>{};
    for (final raw in memberPubkeysHex) {
      final pk = raw.toLowerCase().trim();
      if (pk.isEmpty) continue;
      if (pk == myPubkeyHex) continue;
      if (group.members.contains(pk)) continue;
      if (!seen.add(pk)) continue;
      toAdd.add(pk);
    }
    if (toAdd.isEmpty) return;

    try {
      final updated = group.copyWith(members: [...group.members, ...toAdd]);
      await _groupDatasource.saveGroup(updated);
      state = state.copyWith(
        groups: state.groups.map((g) => g.id == groupId ? updated : g).toList(),
        error: null,
      );

      await _fanOutGroupEvent(
        group: updated,
        kind: _kGroupMetadataKind,
        content: buildGroupMetadataContent(updated),
        tags: [
          [kGroupTagName, updated.id],
        ],
      );
    } catch (e, st) {
      final appError = AppError.from(e, st);
      state = state.copyWith(error: appError.message);
    }
  }

  Future<void> removeGroupMember(String groupId, String memberPubkeyHex) async {
    final group = await getGroup(groupId);
    if (group == null) return;

    final myPubkeyHex = _myPubkeyHex();
    if (myPubkeyHex == null || myPubkeyHex.isEmpty) {
      state = state.copyWith(error: 'Not logged in');
      return;
    }
    if (!isGroupAdmin(group, myPubkeyHex)) {
      state = state.copyWith(error: 'Only group admins can edit the group.');
      return;
    }

    final member = memberPubkeyHex.toLowerCase().trim();
    if (member.isEmpty) return;
    if (!group.members.contains(member)) return;
    if (member == myPubkeyHex) {
      state = state.copyWith(
        error: 'You cannot remove yourself from the group.',
      );
      return;
    }

    final updatedMembers = group.members.where((m) => m != member).toList();
    if (updatedMembers.isEmpty) return;
    final updatedAdmins = group.admins.where((a) => a != member).toList();

    // Rotate the shared secret so removed members cannot decrypt future group messages
    // in clients that use SharedChannel (matches iris-chat semantics).
    final rotatedSecret = generateGroupSecretHex();

    final updated = group.copyWith(
      members: updatedMembers,
      admins: updatedAdmins.isNotEmpty ? updatedAdmins : [myPubkeyHex],
      secret: rotatedSecret,
    );

    try {
      await _groupDatasource.saveGroup(updated);
      state = state.copyWith(
        groups: state.groups.map((g) => g.id == groupId ? updated : g).toList(),
        error: null,
      );

      // Send updated metadata (with rotated secret) to remaining members.
      await _fanOutGroupEvent(
        group: updated,
        kind: _kGroupMetadataKind,
        content: buildGroupMetadataContent(updated),
        tags: [
          [kGroupTagName, updated.id],
        ],
      );

      // Notify the removed member; omit secret.
      await _sendGroupEventToRecipients(
        recipients: [member],
        kind: _kGroupMetadataKind,
        content: buildGroupMetadataContent(updated, excludeSecret: true),
        tags: [
          [kGroupTagName, updated.id],
        ],
      );
    } catch (e, st) {
      final appError = AppError.from(e, st);
      state = state.copyWith(error: appError.message);
    }
  }

  Future<void> deleteGroup(String groupId) async {
    try {
      await _groupDatasource.deleteGroup(groupId);
      await _groupMessageDatasource.deleteMessagesForGroup(groupId);

      final nextGroups = state.groups.where((g) => g.id != groupId).toList();
      final nextMessages = {...state.messages}..remove(groupId);
      state = state.copyWith(groups: nextGroups, messages: nextMessages);
    } catch (e, st) {
      final appError = AppError.from(e, st);
      state = state.copyWith(error: appError.message);
    }
  }

  Future<void> markGroupSeen(String groupId) async {
    final group = await getGroup(groupId);
    if (group == null) return;

    // Mark in-memory messages as seen (local only; no receipts for groups).
    final current = state.messages[groupId] ?? const <ChatMessage>[];
    final updated = current.map((m) {
      if (!m.isIncoming) return m;
      if (m.status == MessageStatus.seen) return m;
      return m.copyWith(status: MessageStatus.seen);
    }).toList();

    state = state.copyWith(messages: {...state.messages, groupId: updated});

    // Persist best-effort.
    unawaited(() async {
      try {
        for (final m in updated) {
          if (!m.isIncoming) continue;
          await _groupMessageDatasource.updateMessageStatus(
            m.id,
            MessageStatus.seen,
          );
        }
      } catch (_) {}
    }());

    // Clear unread counter.
    final updatedGroup = group.copyWith(unreadCount: 0);
    state = state.copyWith(
      groups: state.groups
          .map((g) => g.id == groupId ? updatedGroup : g)
          .toList(),
    );
    unawaited(() async {
      try {
        await _groupDatasource.updateMetadata(groupId, unreadCount: 0);
      } catch (_) {}
    }());
  }

  Future<void> sendGroupMessage(
    String groupId,
    String text, {
    String? replyToId,
  }) async {
    final group = await getGroup(groupId);
    if (group == null) return;
    if (!group.accepted) {
      state = state.copyWith(error: 'Accept the group invitation first.');
      return;
    }

    final myPubkeyHex = _myPubkeyHex();
    if (myPubkeyHex == null || myPubkeyHex.isEmpty) return;

    final trimmed = text.trim();
    if (trimmed.isEmpty) return;

    try {
      final nowMs = DateTime.now().millisecondsSinceEpoch;
      final createdAtSec = nowMs ~/ 1000;

      final tags = <List<String>>[
        [kGroupTagName, groupId],
        ['ms', nowMs.toString()],
        if (replyToId != null && replyToId.trim().isNotEmpty)
          ['e', replyToId.trim(), '', 'reply'],
      ];

      final sendInnerId = await _fanOutGroupEvent(
        group: group,
        kind: _kChatMessageKind,
        content: trimmed,
        tags: tags,
        createdAtSeconds: createdAtSec,
      );

      final rumorId =
          sendInnerId ?? DateTime.now().microsecondsSinceEpoch.toString();

      final message = ChatMessage(
        id: rumorId,
        sessionId: groupSessionId(groupId),
        text: trimmed,
        timestamp: DateTime.fromMillisecondsSinceEpoch(nowMs),
        direction: MessageDirection.outgoing,
        status: MessageStatus.sent,
        rumorId: rumorId,
        senderPubkeyHex: myPubkeyHex,
      );

      // Update UI state.
      final current = state.messages[groupId] ?? const <ChatMessage>[];
      state = state.copyWith(
        messages: {
          ...state.messages,
          groupId: [...current, message],
        },
      );

      // Persist best-effort.
      unawaited(() async {
        try {
          await _groupMessageDatasource.saveMessage(message);
          await _groupDatasource.updateMetadata(
            groupId,
            lastMessageAt: message.timestamp,
            lastMessagePreview: message.text.length > 50
                ? '${message.text.substring(0, 50)}...'
                : message.text,
            unreadCount: 0,
          );
        } catch (_) {}
      }());

      // Update group list state immediately.
      _updateGroupLastMessageInState(
        groupId,
        lastMessageAt: message.timestamp,
        lastMessagePreview: message.text,
        resetUnread: true,
      );
    } catch (e, st) {
      final appError = AppError.from(e, st);
      state = state.copyWith(error: appError.message);
    }
  }

  Future<void> sendGroupReaction({
    required String groupId,
    required String messageId,
    required String emoji,
  }) async {
    final group = await getGroup(groupId);
    if (group == null) return;
    if (!group.accepted) return;

    final myPubkeyHex = _myPubkeyHex();
    if (myPubkeyHex == null || myPubkeyHex.isEmpty) return;

    final trimmed = emoji.trim();
    if (trimmed.isEmpty) return;

    // Optimistic update.
    _applyGroupReaction(groupId, messageId, trimmed, myPubkeyHex);

    final nowMs = DateTime.now().millisecondsSinceEpoch;
    final createdAtSec = nowMs ~/ 1000;
    final tags = <List<String>>[
      [kGroupTagName, groupId],
      ['ms', nowMs.toString()],
      ['e', messageId],
    ];

    try {
      await _fanOutGroupEvent(
        group: group,
        kind: _kReactionKind,
        content: trimmed,
        tags: tags,
        createdAtSeconds: createdAtSec,
      );
    } catch (e, st) {
      final appError = AppError.from(e, st);
      state = state.copyWith(error: appError.message);
    }
  }

  Future<void> sendGroupTyping(String groupId) async {
    final group = await getGroup(groupId);
    if (group == null) return;
    if (!group.accepted) return;

    final myPubkeyHex = _myPubkeyHex();
    if (myPubkeyHex == null || myPubkeyHex.isEmpty) return;

    final nowMs = DateTime.now().millisecondsSinceEpoch;
    final last = _lastTypingSentAtMs[groupId] ?? 0;
    if (nowMs - last < _kTypingThrottle.inMilliseconds) return;
    _lastTypingSentAtMs[groupId] = nowMs;
    final createdAtSec = nowMs ~/ 1000;
    final tags = <List<String>>[
      [kGroupTagName, groupId],
      ['ms', nowMs.toString()],
    ];

    try {
      await _fanOutGroupEvent(
        group: group,
        kind: _kTypingKind,
        content: 'typing',
        tags: tags,
        createdAtSeconds: createdAtSec,
      );
    } catch (_) {}
  }

  Future<void> handleIncomingGroupRumorJson(
    String rumorJson, {
    String? eventId,
  }) async {
    final rumor = NostrRumor.tryParse(rumorJson);
    if (rumor == null) return;
    await _handleGroupRumor(rumor, eventId: eventId);
  }

  Future<void> _handleGroupRumor(NostrRumor rumor, {String? eventId}) async {
    final groupTag = getFirstTagValue(rumor.tags, kGroupTagName);
    final groupId =
        groupTag ??
        (rumor.kind == _kGroupMetadataKind
            ? parseGroupMetadata(rumor.content)?.id
            : null);
    if (groupId == null || groupId.isEmpty) return;

    if (rumor.kind == _kGroupMetadataKind) {
      await _handleGroupMetadata(rumor, groupId);
      return;
    }

    final group = await getGroup(groupId);
    if (group == null) {
      // Queue until we get metadata.
      _queuePending(
        groupId,
        rumorId: rumor.id,
        rumorJson: jsonEncode(_rumorToMap(rumor)),
        eventId: eventId,
      );
      return;
    }

    // Dedupe by stable inner id (rumor.id) once the group exists.
    final nowMs = DateTime.now().millisecondsSinceEpoch;
    final prevSeen = _seenRumorAtMs[rumor.id];
    if (prevSeen != null) return;
    _seenRumorAtMs[rumor.id] = nowMs;
    if (_seenRumorAtMs.length > _kMaxSeenRumors) {
      final keys = _seenRumorAtMs.keys.take(2000).toList();
      for (final k in keys) {
        _seenRumorAtMs.remove(k);
      }
    }

    if (rumor.kind == _kTypingKind) {
      _handleGroupTyping(rumor, groupId, group);
      return;
    }

    if (rumor.kind == _kReactionKind) {
      await _handleGroupReaction(rumor, groupId);
      return;
    }

    if (rumor.kind == _kChatMessageKind) {
      await _handleGroupMessage(rumor, groupId, group, eventId: eventId);
      return;
    }
  }

  Future<void> _handleGroupMetadata(NostrRumor rumor, String groupId) async {
    final metadata = parseGroupMetadata(rumor.content);
    if (metadata == null) return;

    final myPubkeyHex = _myPubkeyHex();
    if (myPubkeyHex == null || myPubkeyHex.isEmpty) return;

    final existing = await getGroup(metadata.id);
    if (existing != null) {
      final result = validateMetadataUpdate(
        existing: existing,
        metadata: metadata,
        senderPubkeyHex: rumor.pubkey,
        myPubkeyHex: myPubkeyHex,
      );
      if (result == MetadataValidation.reject) return;
      if (result == MetadataValidation.removed) {
        await deleteGroup(metadata.id);
        return;
      }

      final updated = applyMetadataUpdate(
        existing: existing,
        metadata: metadata,
      );
      await _groupDatasource.saveGroup(updated);
      state = state.copyWith(
        groups: state.groups
            .map((g) => g.id == updated.id ? updated : g)
            .toList(),
      );
      return;
    }

    if (!validateMetadataCreation(
      metadata: metadata,
      senderPubkeyHex: rumor.pubkey,
      myPubkeyHex: myPubkeyHex,
    )) {
      return;
    }

    final createdAt = rumorTimestamp(rumor);
    final group = ChatGroup(
      id: metadata.id,
      name: metadata.name,
      members: metadata.members,
      admins: metadata.admins,
      description: metadata.description,
      picture: metadata.picture,
      createdAt: createdAt,
      secret: metadata.secret,
      accepted: false,
    );

    await _groupDatasource.saveGroup(group);
    state = state.copyWith(
      groups: [group, ...state.groups.where((g) => g.id != group.id)],
    );

    // Flush any pending events for this group.
    await _flushPending(group.id);
  }

  Future<void> _handleGroupMessage(
    NostrRumor rumor,
    String groupId,
    ChatGroup group, {
    String? eventId,
  }) async {
    final myPubkeyHex = _myPubkeyHex();
    final isMine = myPubkeyHex != null && rumor.pubkey == myPubkeyHex;

    // Persist first to avoid duplicates across UI rebuilds.
    if (await _groupMessageDatasource.messageExists(rumor.id)) return;

    final nowSeconds = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final expiresAtSeconds = getExpirationTimestampSeconds(rumor.tags);
    if (expiresAtSeconds != null && expiresAtSeconds <= nowSeconds) {
      return;
    }

    final replyToId = _resolveReplyToId(rumor.tags);

    final message = ChatMessage(
      id: rumor.id,
      sessionId: groupSessionId(groupId),
      text: rumor.content,
      timestamp: rumorTimestamp(rumor),
      expiresAt: expiresAtSeconds,
      direction: isMine ? MessageDirection.outgoing : MessageDirection.incoming,
      status: isMine ? MessageStatus.sent : MessageStatus.delivered,
      eventId: eventId,
      rumorId: rumor.id,
      replyToId: replyToId,
      senderPubkeyHex: rumor.pubkey,
    );

    await _groupMessageDatasource.saveMessage(message);

    // Update in-memory list.
    final current = state.messages[groupId] ?? const <ChatMessage>[];
    if (current.any((m) => m.id == message.id)) return;
    final updated = [...current, message]
      ..sort((a, b) => a.timestamp.compareTo(b.timestamp));
    state = state.copyWith(messages: {...state.messages, groupId: updated});

    final lastPreview = message.text.length > 50
        ? '${message.text.substring(0, 50)}...'
        : message.text;

    // Update group last message + unread.
    final incUnread = !isMine;
    _updateGroupLastMessageInState(
      groupId,
      lastMessageAt: message.timestamp,
      lastMessagePreview: message.text,
      incrementUnread: incUnread,
    );

    unawaited(() async {
      try {
        await _groupDatasource.updateMetadata(
          groupId,
          lastMessageAt: message.timestamp,
          lastMessagePreview: lastPreview,
          unreadCount: incUnread ? group.unreadCount + 1 : null,
        );
      } catch (_) {}
    }());
  }

  Future<void> _handleGroupReaction(NostrRumor rumor, String groupId) async {
    final messageId = getFirstTagValue(rumor.tags, 'e');
    if (messageId == null || messageId.isEmpty) return;
    _applyGroupReaction(groupId, messageId, rumor.content, rumor.pubkey);
  }

  void _handleGroupTyping(NostrRumor rumor, String groupId, ChatGroup group) {
    final myPubkeyHex = _myPubkeyHex();
    if (myPubkeyHex != null && rumor.pubkey == myPubkeyHex) return;

    final tsMs = rumorTimestamp(rumor).millisecondsSinceEpoch;
    final lastMsgAt = group.lastMessageAt?.millisecondsSinceEpoch ?? 0;
    if (tsMs <= lastMsgAt) return;

    _typingExpiryTimers[groupId]?.cancel();
    state = state.copyWith(
      typingStates: {...state.typingStates, groupId: true},
    );
    _typingExpiryTimers[groupId] = Timer(_kTypingExpiry, () {
      _typingExpiryTimers.remove(groupId);
      final next = {...state.typingStates}..remove(groupId);
      state = state.copyWith(typingStates: next);
    });
  }

  void _applyGroupReaction(
    String groupId,
    String messageId,
    String emoji,
    String pubkeyHex,
  ) {
    final current = state.messages[groupId] ?? const <ChatMessage>[];
    var idx = current.indexWhere((m) => m.id == messageId);
    if (idx == -1) {
      idx = current.indexWhere((m) => m.rumorId == messageId);
    }
    if (idx == -1) return;

    final message = current[idx];
    final reactions = <String, List<String>>{};

    for (final entry in message.reactions.entries) {
      final filtered = entry.value.where((u) => u != pubkeyHex).toList();
      if (filtered.isNotEmpty) reactions[entry.key] = filtered;
    }
    reactions[emoji] = [...(reactions[emoji] ?? []), pubkeyHex];

    final updatedMessage = message.copyWith(reactions: reactions);
    final next = [...current];
    next[idx] = updatedMessage;
    state = state.copyWith(messages: {...state.messages, groupId: next});

    unawaited(() async {
      try {
        await _groupMessageDatasource.saveMessage(updatedMessage);
      } catch (_) {}
    }());
  }

  void _queuePending(
    String groupId, {
    required String rumorId,
    required String rumorJson,
    String? eventId,
  }) {
    final list = _pendingByGroupId.putIfAbsent(
      groupId,
      () => <_PendingGroupEvent>[],
    );
    if (list.length >= _kMaxPendingPerGroup) return;
    if (list.any((p) => p.rumorId == rumorId)) return;
    list.add(
      _PendingGroupEvent(
        rumorId: rumorId,
        rumorJson: rumorJson,
        receivedAtMs: DateTime.now().millisecondsSinceEpoch,
        eventId: eventId,
      ),
    );
  }

  Future<void> _flushPending(String groupId) async {
    final pending = _pendingByGroupId.remove(groupId);
    if (pending == null || pending.isEmpty) return;

    final now = DateTime.now().millisecondsSinceEpoch;
    for (final p in pending) {
      if (now - p.receivedAtMs > _kPendingMaxAge.inMilliseconds) continue;
      final rumor = NostrRumor.tryParse(p.rumorJson);
      if (rumor == null) continue;
      await _handleGroupRumor(rumor, eventId: p.eventId);
    }
  }

  /// Fan-out a group-tagged inner rumor to all group members (excluding self).
  ///
  /// Important: group events intentionally do *not* include `p` tags so the inner rumor id
  /// is stable across all recipients. The outer event encryption already targets each
  /// recipient device via SessionManager.
  Future<String?> _fanOutGroupEvent({
    required ChatGroup group,
    required int kind,
    required String content,
    required List<List<String>> tags,
    int? createdAtSeconds,
  }) async {
    final myPubkeyHex = _myPubkeyHex();
    if (myPubkeyHex == null || myPubkeyHex.isEmpty) return null;

    final recipients = group.members.where((m) => m != myPubkeyHex).toList();
    return _sendGroupEventToRecipients(
      recipients: recipients,
      kind: kind,
      content: content,
      tags: tags,
      createdAtSeconds: createdAtSeconds,
    );
  }

  Future<String?> _sendGroupEventToRecipients({
    required List<String> recipients,
    required int kind,
    required String content,
    required List<List<String>> tags,
    int? createdAtSeconds,
  }) async {
    final myPubkeyHex = _myPubkeyHex();
    if (myPubkeyHex == null || myPubkeyHex.isEmpty) return null;

    if (recipients.isEmpty) return null;
    final tagsJson = jsonEncode(tags);

    String? innerId;
    for (final raw in recipients) {
      final member = raw.toLowerCase().trim();
      if (member.isEmpty) continue;
      if (member == myPubkeyHex) continue;

      final sendResult = await _sessionManagerService.sendEventWithInnerId(
        recipientPubkeyHex: member,
        kind: kind,
        content: content,
        tagsJson: tagsJson,
        createdAtSeconds: createdAtSeconds,
      );
      if (innerId == null && sendResult.innerId.isNotEmpty) {
        innerId = sendResult.innerId;
      }
    }
    return innerId;
  }

  void _updateGroupLastMessageInState(
    String groupId, {
    required DateTime lastMessageAt,
    required String lastMessagePreview,
    bool incrementUnread = false,
    bool resetUnread = false,
  }) {
    final nextGroups = state.groups.map((g) {
      if (g.id != groupId) return g;

      final nextUnread = resetUnread
          ? 0
          : incrementUnread
          ? (g.unreadCount + 1)
          : g.unreadCount;

      return g.copyWith(
        lastMessageAt: lastMessageAt,
        lastMessagePreview: lastMessagePreview.length > 50
            ? '${lastMessagePreview.substring(0, 50)}...'
            : lastMessagePreview,
        unreadCount: nextUnread,
      );
    }).toList();

    state = state.copyWith(groups: nextGroups);
  }

  static String? _resolveReplyToId(List<List<String>> tags) {
    for (final t in tags) {
      if (t.length < 2) continue;
      if (t[0] != 'e') continue;
      if (t.length >= 4 && t[3] == 'reply') return t[1];
    }
    // Fallback: first e tag.
    return getFirstTagValue(tags, 'e');
  }

  static Map<String, dynamic> _rumorToMap(NostrRumor rumor) {
    return {
      'id': rumor.id,
      'pubkey': rumor.pubkey,
      'created_at': rumor.createdAt,
      'kind': rumor.kind,
      'content': rumor.content,
      'tags': rumor.tags,
    };
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

final groupDatasourceProvider = Provider<GroupLocalDatasource>((ref) {
  final db = ref.watch(databaseServiceProvider);
  return GroupLocalDatasource(db);
});

final groupMessageDatasourceProvider = Provider<GroupMessageLocalDatasource>((
  ref,
) {
  final db = ref.watch(databaseServiceProvider);
  return GroupMessageLocalDatasource(db);
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
  return ChatNotifier(
    messageDatasource,
    sessionDatasource,
    sessionManagerService,
  );
});

final groupStateProvider = StateNotifierProvider<GroupNotifier, GroupState>((
  ref,
) {
  final groupDatasource = ref.watch(groupDatasourceProvider);
  final groupMessageDatasource = ref.watch(groupMessageDatasourceProvider);
  final sessionManagerService = ref.watch(sessionManagerServiceProvider);
  return GroupNotifier(
    groupDatasource,
    groupMessageDatasource,
    sessionManagerService,
  );
});

final groupMessagesProvider = Provider.family<List<ChatMessage>, String>((
  ref,
  groupId,
) {
  return ref.watch(
    groupStateProvider.select(
      (s) => s.messages[groupId] ?? const <ChatMessage>[],
    ),
  );
});

/// Provider for messages in a specific session.
/// Performance: Uses select() to only rebuild when messages for this specific session change.
final sessionMessagesProvider = Provider.family<List<ChatMessage>, String>((
  ref,
  sessionId,
) {
  // Use select to only watch messages for this specific session
  return ref.watch(
    chatStateProvider.select((state) => state.messages[sessionId] ?? []),
  );
});

/// Provider for message count in a specific session.
/// Useful for UI that only needs to know if there are messages without watching the full list.
final sessionMessageCountProvider = Provider.family<int, String>((
  ref,
  sessionId,
) {
  return ref.watch(
    chatStateProvider.select((state) => state.messages[sessionId]?.length ?? 0),
  );
});

/// Provider for checking if a session has messages.
/// More efficient than watching the full message list when you only need a boolean.
final sessionHasMessagesProvider = Provider.family<bool, String>((
  ref,
  sessionId,
) {
  return ref.watch(
    chatStateProvider.select(
      (state) => state.messages[sessionId]?.isNotEmpty ?? false,
    ),
  );
});

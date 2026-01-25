import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:freezed_annotation/freezed_annotation.dart';

import '../../core/ffi/ndr_ffi.dart';
import '../../core/services/database_service.dart';
import '../../core/services/error_service.dart';
import '../../core/services/nostr_service.dart';
import '../../features/chat/data/datasources/message_local_datasource.dart';
import '../../features/chat/data/datasources/session_local_datasource.dart';
import '../../features/chat/data/repositories/chat_repository_impl.dart';
import '../../features/chat/domain/models/message.dart';
import '../../features/chat/domain/models/session.dart';
import '../../features/chat/domain/repositories/chat_repository.dart';
import 'nostr_provider.dart';

part 'chat_provider.freezed.dart';

/// State for chat sessions.
@freezed
class SessionState with _$SessionState {
  const factory SessionState({
    @Default([]) List<ChatSession> sessions,
    @Default(false) bool isLoading,
    String? error,
  }) = _SessionState;
}

/// State for messages in a chat.
@freezed
class ChatState with _$ChatState {
  const factory ChatState({
    @Default({}) Map<String, List<ChatMessage>> messages,
    @Default({}) Map<String, int> unreadCounts,
    @Default({}) Map<String, bool> sendingStates,
    String? error,
  }) = _ChatState;
}

/// Notifier for session state.
class SessionNotifier extends StateNotifier<SessionState> {
  SessionNotifier(this._sessionDatasource) : super(const SessionState());

  final SessionLocalDatasource _sessionDatasource;

  /// Load all sessions from storage.
  Future<void> loadSessions() async {
    state = state.copyWith(isLoading: true, error: null);
    try {
      final sessions = await _sessionDatasource.getAllSessions();
      state = state.copyWith(sessions: sessions, isLoading: false);
    } catch (e, st) {
      final appError = AppError.from(e, st);
      state = state.copyWith(isLoading: false, error: appError.message);
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
    this._nostrService,
  ) : super(const ChatState());

  final MessageLocalDatasource _messageDatasource;
  final SessionLocalDatasource _sessionDatasource;
  final NostrService _nostrService;

  // Cache of session handles for sending/receiving
  final Map<String, SessionHandle> _sessionHandles = {};

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
      // Get or restore the session handle
      final handle = await _getSessionHandle(message.sessionId);
      if (handle == null) {
        throw const AppError(
          type: AppErrorType.sessionExpired,
          message: 'Session not found. Please start a new conversation.',
          isRetryable: false,
        );
      }

      // Check if can send
      final canSend = await handle.canSend();
      if (!canSend) {
        throw const AppError(
          type: AppErrorType.sessionExpired,
          message: 'Session is not ready. Please wait for the connection.',
          isRetryable: true,
        );
      }

      // Encrypt and get event
      final sendResult = await handle.sendText(message.text);

      // Update session state
      final newState = await handle.stateJson();
      await _sessionDatasource.saveSessionState(message.sessionId, newState);

      // Publish to Nostr with retry logic for network failures
      await ErrorService.withRetry(
        operation: () => _nostrService.publishEvent(sendResult.outerEventJson),
        maxAttempts: 3,
        initialDelay: const Duration(seconds: 1),
      );

      // Parse event ID
      final eventData = jsonDecode(sendResult.outerEventJson) as Map<String, dynamic>;
      final eventId = eventData['id'] as String;

      // Update message with success
      final sentMessage = message.copyWith(
        status: MessageStatus.sent,
        eventId: eventId,
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

  /// Receive a message from Nostr.
  Future<void> receiveMessage(String sessionId, String eventJson, {String? senderPubkey}) async {
    try {
      // Check if already have this message
      final eventData = jsonDecode(eventJson) as Map<String, dynamic>;
      final eventId = eventData['id'] as String;

      if (await _messageDatasource.messageExists(eventId)) {
        return; // Already have this message
      }

      // Get or restore the session handle
      final handle = await _getSessionHandle(sessionId);
      if (handle == null) {
        return;
      }

      // Decrypt
      final decryptResult = await handle.decryptEvent(eventJson);

      // Update session state
      final newState = await handle.stateJson();
      await _sessionDatasource.saveSessionState(sessionId, newState);

      // Check if this is a reaction
      final reactionPayload = parseReactionPayload(decryptResult.plaintext);
      if (reactionPayload != null && senderPubkey != null) {
        handleIncomingReaction(
          sessionId,
          reactionPayload['messageId'] as String,
          reactionPayload['emoji'] as String,
          senderPubkey,
        );
        return;
      }

      // Parse timestamp
      final createdAt = eventData['created_at'] as int;
      final timestamp = DateTime.fromMillisecondsSinceEpoch(createdAt * 1000);

      // Create message
      final message = ChatMessage.incoming(
        sessionId: sessionId,
        text: decryptResult.plaintext,
        eventId: eventId,
        timestamp: timestamp,
      );

      // Save and add to state
      await addReceivedMessage(message);
    } catch (e, st) {
      final appError = AppError.from(e, st);
      state = state.copyWith(error: appError.message);
    }
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
    if (message.eventId != null) {
      final exists = await _messageDatasource.messageExists(message.eventId!);
      if (exists) return;
    }

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

      final handle = await _getSessionHandle(sessionId);
      if (handle == null) return;

      // Send reaction as JSON payload
      final payload = jsonEncode({
        'type': 'reaction',
        'messageId': reactionMessageId,
        'emoji': emoji,
      });

      final sendResult = await handle.sendText(payload);

      // Update session state
      final newState = await handle.stateJson();
      await _sessionDatasource.saveSessionState(sessionId, newState);

      // Publish to Nostr
      await _nostrService.publishEvent(sendResult.outerEventJson);

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

  /// Get or restore a session handle.
  Future<SessionHandle?> _getSessionHandle(String sessionId) async {
    if (_sessionHandles.containsKey(sessionId)) {
      return _sessionHandles[sessionId];
    }

    final stateJson = await _sessionDatasource.getSessionState(sessionId);
    if (stateJson == null) return null;

    try {
      final handle = await NdrFfi.sessionFromStateJson(stateJson);
      _sessionHandles[sessionId] = handle;
      return handle;
    } catch (e) {
      return null;
    }
  }

  /// Cache a session handle.
  void cacheSessionHandle(String sessionId, SessionHandle handle) {
    _sessionHandles[sessionId] = handle;
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
  return SessionNotifier(datasource);
});

final chatStateProvider = StateNotifierProvider<ChatNotifier, ChatState>((ref) {
  final messageDatasource = ref.watch(messageDatasourceProvider);
  final sessionDatasource = ref.watch(sessionDatasourceProvider);
  final nostrService = ref.watch(nostrServiceProvider);
  return ChatNotifier(messageDatasource, sessionDatasource, nostrService);
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

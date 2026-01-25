import 'dart:convert';

import '../../../../core/ffi/ndr_ffi.dart';
import '../../../../core/services/nostr_service.dart';
import '../../domain/models/message.dart';
import '../../domain/models/session.dart';
import '../../domain/repositories/chat_repository.dart';
import '../datasources/message_local_datasource.dart';
import '../datasources/session_local_datasource.dart';

/// Implementation of [ChatRepository].
class ChatRepositoryImpl implements ChatRepository {
  ChatRepositoryImpl({
    required SessionLocalDatasource sessionDatasource,
    required MessageLocalDatasource messageDatasource,
    required NostrService nostrService,
  })  : _sessionDatasource = sessionDatasource,
        _messageDatasource = messageDatasource,
        _nostrService = nostrService;

  final SessionLocalDatasource _sessionDatasource;
  final MessageLocalDatasource _messageDatasource;
  final NostrService _nostrService;

  // Cache of active session handles
  final Map<String, SessionHandle> _sessionHandles = {};

  @override
  Future<List<ChatSession>> getSessions() async {
    return _sessionDatasource.getAllSessions();
  }

  @override
  Future<ChatSession?> getSession(String id) async {
    return _sessionDatasource.getSession(id);
  }

  @override
  Future<void> saveSession(ChatSession session) async {
    await _sessionDatasource.saveSession(session);
  }

  @override
  Future<void> deleteSession(String id) async {
    // Dispose the session handle if cached
    final handle = _sessionHandles.remove(id);
    if (handle != null) {
      await handle.dispose();
    }

    // Delete messages first (foreign key constraint)
    await _messageDatasource.deleteMessagesForSession(id);
    await _sessionDatasource.deleteSession(id);
  }

  @override
  Future<void> updateSessionMetadata(
    String id, {
    DateTime? lastMessageAt,
    String? lastMessagePreview,
    int? unreadCount,
  }) async {
    await _sessionDatasource.updateMetadata(
      id,
      lastMessageAt: lastMessageAt,
      lastMessagePreview: lastMessagePreview,
      unreadCount: unreadCount,
    );
  }

  @override
  Future<List<ChatMessage>> getMessages(
    String sessionId, {
    int? limit,
    String? beforeId,
  }) async {
    return _messageDatasource.getMessagesForSession(
      sessionId,
      limit: limit,
      beforeId: beforeId,
    );
  }

  @override
  Future<ChatMessage> sendMessage({
    required String sessionId,
    required String text,
    String? replyToId,
  }) async {
    // Get or restore the session handle
    final handle = await _getSessionHandle(sessionId);
    if (handle == null) {
      throw Exception('Session not found or cannot be restored');
    }

    // Check if session can send
    final canSend = await handle.canSend();
    if (!canSend) {
      throw Exception('Session is not ready to send');
    }

    // Create optimistic message
    final message = ChatMessage.outgoing(
      sessionId: sessionId,
      text: text,
      replyToId: replyToId,
    );

    // Save message with pending status
    await _messageDatasource.saveMessage(message);

    try {
      // Encrypt and send via FFI
      final sendResult = await handle.sendText(text);

      // Update session state (ratchet advanced)
      final newState = await handle.stateJson();
      await _sessionDatasource.saveSessionState(sessionId, newState);

      // Publish to Nostr relays
      await _nostrService.publishEvent(sendResult.outerEventJson);

      // Parse event to get ID
      final eventData = jsonDecode(sendResult.outerEventJson) as Map<String, dynamic>;
      final eventId = eventData['id'] as String;

      // Update message with sent status and event ID
      final sentMessage = message.copyWith(
        status: MessageStatus.sent,
        eventId: eventId,
      );
      await _messageDatasource.saveMessage(sentMessage);

      // Update session metadata
      await updateSessionMetadata(
        sessionId,
        lastMessageAt: message.timestamp,
        lastMessagePreview: text.length > 50 ? '${text.substring(0, 50)}...' : text,
      );

      return sentMessage;
    } catch (e) {
      // Update message with failed status
      final failedMessage = message.copyWith(status: MessageStatus.failed);
      await _messageDatasource.saveMessage(failedMessage);
      rethrow;
    }
  }

  @override
  Future<ChatMessage> receiveMessage({
    required String sessionId,
    required String eventJson,
  }) async {
    // Check if we already have this message
    final eventData = jsonDecode(eventJson) as Map<String, dynamic>;
    final eventId = eventData['id'] as String;

    if (await _messageDatasource.messageExists(eventId)) {
      throw Exception('Message already exists');
    }

    // Get or restore the session handle
    final handle = await _getSessionHandle(sessionId);
    if (handle == null) {
      throw Exception('Session not found or cannot be restored');
    }

    // Decrypt the message
    final decryptResult = await handle.decryptEvent(eventJson);

    // Update session state (ratchet advanced)
    final newState = await handle.stateJson();
    await _sessionDatasource.saveSessionState(sessionId, newState);

    // Parse timestamp from event
    final createdAt = eventData['created_at'] as int;
    final timestamp = DateTime.fromMillisecondsSinceEpoch(createdAt * 1000);

    // Create and save the message
    final message = ChatMessage.incoming(
      sessionId: sessionId,
      text: decryptResult.plaintext,
      eventId: eventId,
      timestamp: timestamp,
    );

    await _messageDatasource.saveMessage(message);

    // Update session metadata
    await updateSessionMetadata(
      sessionId,
      lastMessageAt: timestamp,
      lastMessagePreview: decryptResult.plaintext.length > 50
          ? '${decryptResult.plaintext.substring(0, 50)}...'
          : decryptResult.plaintext,
    );

    return message;
  }

  @override
  Future<void> updateMessageStatus(String messageId, MessageStatus status) async {
    await _messageDatasource.updateMessageStatus(messageId, status);
  }

  @override
  Future<void> deleteMessage(String messageId) async {
    await _messageDatasource.deleteMessage(messageId);
  }

  @override
  Future<void> markSessionAsRead(String sessionId) async {
    await _sessionDatasource.updateMetadata(sessionId, unreadCount: 0);
  }

  @override
  Future<String?> getSessionState(String sessionId) async {
    return _sessionDatasource.getSessionState(sessionId);
  }

  @override
  Future<void> saveSessionState(String sessionId, String state) async {
    await _sessionDatasource.saveSessionState(sessionId, state);
  }

  /// Get or restore a session handle from cache or storage.
  Future<SessionHandle?> _getSessionHandle(String sessionId) async {
    // Check cache first
    if (_sessionHandles.containsKey(sessionId)) {
      return _sessionHandles[sessionId];
    }

    // Try to restore from storage
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

  /// Cache a session handle (used when creating new sessions).
  void cacheSessionHandle(String sessionId, SessionHandle handle) {
    _sessionHandles[sessionId] = handle;
  }

  /// Dispose all cached session handles.
  Future<void> dispose() async {
    for (final handle in _sessionHandles.values) {
      await handle.dispose();
    }
    _sessionHandles.clear();
  }
}

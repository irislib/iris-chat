import 'dart:convert';

import 'package:sqflite/sqflite.dart';

import '../../../../core/services/database_service.dart';
import '../../domain/models/message.dart';

/// Local data source for chat messages.
class MessageLocalDatasource {
  MessageLocalDatasource(this._databaseService);

  final DatabaseService _databaseService;

  Future<Database> get _db => _databaseService.database;

  /// Get messages for a session.
  Future<List<ChatMessage>> getMessagesForSession(
    String sessionId, {
    int? limit,
    String? beforeId,
  }) async {
    final db = await _db;

    final nowSeconds = DateTime.now().millisecondsSinceEpoch ~/ 1000;

    String? where = 'session_id = ? AND (expires_at IS NULL OR expires_at > ?)';
    List<dynamic> whereArgs = [sessionId, nowSeconds];

    if (beforeId != null) {
      // Get the timestamp of the reference message
      final refMsg = await db.query(
        'messages',
        columns: ['timestamp'],
        where: 'id = ?',
        whereArgs: [beforeId],
        limit: 1,
      );
      if (refMsg.isNotEmpty) {
        final refTimestamp = refMsg.first['timestamp'] as int;
        where =
            'session_id = ? AND timestamp < ? AND (expires_at IS NULL OR expires_at > ?)';
        whereArgs = [sessionId, refTimestamp, nowSeconds];
      }
    }

    final maps = await db.query(
      'messages',
      where: where,
      whereArgs: whereArgs,
      orderBy: 'timestamp DESC',
      limit: limit,
    );

    // Return in chronological order
    return maps.map(_messageFromMap).toList().reversed.toList();
  }

  /// Save a message.
  Future<void> saveMessage(ChatMessage message) async {
    final db = await _db;
    await db.insert(
      'messages',
      _messageToMap(message),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  /// Update message status.
  Future<void> updateMessageStatus(String id, MessageStatus status) async {
    final db = await _db;
    await db.update(
      'messages',
      {'status': status.name},
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  /// Delete a message.
  Future<void> deleteMessage(String id) async {
    final db = await _db;
    await db.delete('messages', where: 'id = ?', whereArgs: [id]);
  }

  /// Delete all messages for a session.
  Future<void> deleteMessagesForSession(String sessionId) async {
    final db = await _db;
    await db.delete(
      'messages',
      where: 'session_id = ?',
      whereArgs: [sessionId],
    );
  }

  /// Get the count of unread messages for a session.
  Future<int> getUnreadCount(String sessionId) async {
    final db = await _db;
    final result = await db.rawQuery(
      'SELECT COUNT(*) as count FROM messages WHERE session_id = ? AND direction = ? AND status != ?',
      [sessionId, MessageDirection.incoming.name, MessageStatus.seen.name],
    );
    return Sqflite.firstIntValue(result) ?? 0;
  }

  /// Return the earliest known expiration timestamp (unix seconds) across all messages.
  Future<int?> getNextExpirationSeconds() async {
    final db = await _db;
    final result = await db.rawQuery(
      'SELECT MIN(expires_at) as min_expires_at FROM messages WHERE expires_at IS NOT NULL',
    );
    if (result.isEmpty) return null;
    final v = result.first['min_expires_at'];
    return v is int ? v : null;
  }

  /// Delete all messages whose `expires_at` is <= [nowSeconds].
  ///
  /// Returns the session ids that were affected.
  Future<List<String>> deleteExpiredMessages(int nowSeconds) async {
    final db = await _db;

    final affected = await db.rawQuery(
      '''
SELECT DISTINCT session_id
FROM messages
WHERE expires_at IS NOT NULL
  AND expires_at <= ?
''',
      [nowSeconds],
    );

    if (affected.isEmpty) return const <String>[];

    await db.delete(
      'messages',
      where: 'expires_at IS NOT NULL AND expires_at <= ?',
      whereArgs: [nowSeconds],
    );

    return affected.map((row) => row['session_id'].toString()).toList();
  }

  /// Check if a message with the given event ID exists.
  Future<bool> messageExists(String idOrEventIdOrRumorId) async {
    final db = await _db;
    final result = await db.query(
      'messages',
      columns: ['id'],
      where: 'id = ? OR rumor_id = ? OR event_id = ?',
      whereArgs: [
        idOrEventIdOrRumorId,
        idOrEventIdOrRumorId,
        idOrEventIdOrRumorId,
      ],
      limit: 1,
    );
    return result.isNotEmpty;
  }

  /// Update message status by stable rumor id (outgoing messages store this in `rumor_id`).
  Future<void> updateOutgoingStatusByRumorId(
    String rumorId,
    MessageStatus status,
  ) async {
    final db = await _db;
    final extraWhere = status == MessageStatus.delivered
        ? ' AND status != ?'
        : '';
    final extraArgs = status == MessageStatus.delivered
        ? [MessageStatus.seen.name]
        : const <Object>[];
    await db.update(
      'messages',
      {'status': status.name},
      where: '(rumor_id = ? OR id = ?) AND direction = ?$extraWhere',
      whereArgs: [
        rumorId,
        rumorId,
        MessageDirection.outgoing.name,
        ...extraArgs,
      ],
    );
  }

  /// Backfill the outer Nostr event id for an outgoing message using its stable rumor id.
  ///
  /// This fixes "stuck pending" UI when `sendTextWithInnerId` couldn't provide an
  /// outer event id, but we later receive a relay echo / decrypted self-copy.
  Future<void> updateOutgoingEventIdByRumorId(
    String rumorId,
    String eventId,
  ) async {
    final db = await _db;
    await db.rawUpdate(
      '''
UPDATE messages
SET event_id = ?,
    status = CASE
      WHEN status IN (?, ?) THEN ?
      ELSE status
    END
WHERE (rumor_id = ? OR id = ?)
  AND direction = ?
''',
      [
        eventId,
        MessageStatus.pending.name,
        MessageStatus.queued.name,
        MessageStatus.sent.name,
        rumorId,
        rumorId,
        MessageDirection.outgoing.name,
      ],
    );
  }

  /// Update incoming message status by stable rumor id (incoming messages use `id == rumorId`).
  Future<void> updateIncomingStatusByRumorId(
    String rumorId,
    MessageStatus status,
  ) async {
    final db = await _db;
    final extraWhere = status == MessageStatus.delivered
        ? ' AND status != ?'
        : '';
    final extraArgs = status == MessageStatus.delivered
        ? [MessageStatus.seen.name]
        : const <Object>[];
    await db.update(
      'messages',
      {'status': status.name},
      where: '(rumor_id = ? OR id = ?) AND direction = ?$extraWhere',
      whereArgs: [
        rumorId,
        rumorId,
        MessageDirection.incoming.name,
        ...extraArgs,
      ],
    );
  }

  ChatMessage _messageFromMap(Map<String, dynamic> map) {
    Map<String, List<String>> reactions = {};
    final reactionsJson = map['reactions'] as String?;
    if (reactionsJson != null && reactionsJson.isNotEmpty) {
      final decoded = jsonDecode(reactionsJson) as Map<String, dynamic>;
      reactions = decoded.map(
        (k, v) => MapEntry(k, (v as List).cast<String>()),
      );
    }

    return ChatMessage(
      id: map['id'] as String,
      sessionId: map['session_id'] as String,
      text: map['text'] as String,
      timestamp: DateTime.fromMillisecondsSinceEpoch(map['timestamp'] as int),
      expiresAt: map['expires_at'] as int?,
      direction: MessageDirection.values.byName(map['direction'] as String),
      status: MessageStatus.values.byName(map['status'] as String),
      eventId: map['event_id'] as String?,
      rumorId: map['rumor_id'] as String?,
      replyToId: map['reply_to_id'] as String?,
      reactions: reactions,
      senderPubkeyHex: map['sender_pubkey_hex'] as String?,
    );
  }

  Map<String, dynamic> _messageToMap(ChatMessage message) {
    return {
      'id': message.id,
      'session_id': message.sessionId,
      'text': message.text,
      'timestamp': message.timestamp.millisecondsSinceEpoch,
      'direction': message.direction.name,
      'status': message.status.name,
      'event_id': message.eventId,
      'rumor_id': message.rumorId,
      'reply_to_id': message.replyToId,
      'reactions': message.reactions.isEmpty
          ? null
          : jsonEncode(message.reactions),
      'expires_at': message.expiresAt,
      'sender_pubkey_hex': message.senderPubkeyHex,
    };
  }
}

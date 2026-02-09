import 'dart:convert';

import 'package:sqflite/sqflite.dart';

import '../../../../core/services/database_service.dart';
import '../../domain/models/message.dart';

const String _kGroupSessionPrefix = 'group:';

String groupSessionId(String groupId) => '$_kGroupSessionPrefix$groupId';

String? tryParseGroupIdFromSessionId(String sessionId) {
  if (!sessionId.startsWith(_kGroupSessionPrefix)) return null;
  final id = sessionId.substring(_kGroupSessionPrefix.length);
  return id.isEmpty ? null : id;
}

/// Local data source for group chat messages.
class GroupMessageLocalDatasource {
  GroupMessageLocalDatasource(this._databaseService);

  final DatabaseService _databaseService;

  Future<Database> get _db => _databaseService.database;

  /// Get messages for a group.
  Future<List<ChatMessage>> getMessagesForGroup(
    String groupId, {
    int? limit,
    String? beforeId,
  }) async {
    final db = await _db;

    final nowSeconds = DateTime.now().millisecondsSinceEpoch ~/ 1000;

    String? where = 'group_id = ? AND (expires_at IS NULL OR expires_at > ?)';
    List<dynamic> whereArgs = [groupId, nowSeconds];

    if (beforeId != null) {
      // Get the timestamp of the reference message.
      final refMsg = await db.query(
        'group_messages',
        columns: ['timestamp'],
        where: 'id = ?',
        whereArgs: [beforeId],
        limit: 1,
      );
      if (refMsg.isNotEmpty) {
        final refTimestamp = refMsg.first['timestamp'] as int;
        where =
            'group_id = ? AND timestamp < ? AND (expires_at IS NULL OR expires_at > ?)';
        whereArgs = [groupId, refTimestamp, nowSeconds];
      }
    }

    final maps = await db.query(
      'group_messages',
      where: where,
      whereArgs: whereArgs,
      orderBy: 'timestamp DESC',
      limit: limit,
    );

    // Return in chronological order.
    return maps
        .map((m) => _messageFromMap(groupId, m))
        .toList()
        .reversed
        .toList();
  }

  /// Save a message.
  Future<void> saveMessage(ChatMessage message) async {
    final groupId = tryParseGroupIdFromSessionId(message.sessionId);
    if (groupId == null) {
      throw ArgumentError.value(
        message.sessionId,
        'sessionId',
        'Expected group session id in the form "group:<id>"',
      );
    }

    final db = await _db;
    await db.insert(
      'group_messages',
      _messageToMap(groupId, message),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  /// Update message status.
  Future<void> updateMessageStatus(String id, MessageStatus status) async {
    final db = await _db;
    await db.update(
      'group_messages',
      {'status': status.name},
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  /// Delete a single message by id.
  Future<void> deleteMessage(String id) async {
    final db = await _db;
    await db.delete('group_messages', where: 'id = ?', whereArgs: [id]);
  }

  /// Delete all messages for a group.
  Future<void> deleteMessagesForGroup(String groupId) async {
    final db = await _db;
    await db.delete(
      'group_messages',
      where: 'group_id = ?',
      whereArgs: [groupId],
    );
  }

  /// Return the earliest known expiration timestamp (unix seconds) across all group messages.
  Future<int?> getNextExpirationSeconds() async {
    final db = await _db;
    final result = await db.rawQuery(
      'SELECT MIN(expires_at) as min_expires_at FROM group_messages WHERE expires_at IS NOT NULL',
    );
    if (result.isEmpty) return null;
    final v = result.first['min_expires_at'];
    return v is int ? v : null;
  }

  /// Delete all group messages whose `expires_at` is <= [nowSeconds].
  ///
  /// Returns the group ids that were affected.
  Future<List<String>> deleteExpiredMessages(int nowSeconds) async {
    final db = await _db;

    final affected = await db.rawQuery(
      '''
SELECT DISTINCT group_id
FROM group_messages
WHERE expires_at IS NOT NULL
  AND expires_at <= ?
''',
      [nowSeconds],
    );

    if (affected.isEmpty) return const <String>[];

    await db.delete(
      'group_messages',
      where: 'expires_at IS NOT NULL AND expires_at <= ?',
      whereArgs: [nowSeconds],
    );

    return affected.map((row) => row['group_id'].toString()).toList();
  }

  /// Check if a message with the given id/eventId/rumorId exists.
  Future<bool> messageExists(String idOrEventIdOrRumorId) async {
    final db = await _db;
    final result = await db.query(
      'group_messages',
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

  ChatMessage _messageFromMap(String groupId, Map<String, dynamic> map) {
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
      sessionId: groupSessionId(groupId),
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

  Map<String, dynamic> _messageToMap(String groupId, ChatMessage message) {
    return {
      'id': message.id,
      'group_id': groupId,
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

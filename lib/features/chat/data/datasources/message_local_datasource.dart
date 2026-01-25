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

    String? where = 'session_id = ?';
    List<dynamic> whereArgs = [sessionId];

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
        where = 'session_id = ? AND timestamp < ?';
        whereArgs = [sessionId, refTimestamp];
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
    await db.delete('messages', where: 'session_id = ?', whereArgs: [sessionId]);
  }

  /// Get the count of unread messages for a session.
  Future<int> getUnreadCount(String sessionId) async {
    final db = await _db;
    final result = await db.rawQuery(
      'SELECT COUNT(*) as count FROM messages WHERE session_id = ? AND direction = ? AND status != ?',
      [sessionId, MessageDirection.incoming.name, MessageStatus.delivered.name],
    );
    return Sqflite.firstIntValue(result) ?? 0;
  }

  /// Check if a message with the given event ID exists.
  Future<bool> messageExists(String eventId) async {
    final db = await _db;
    final result = await db.query(
      'messages',
      columns: ['id'],
      where: 'event_id = ?',
      whereArgs: [eventId],
      limit: 1,
    );
    return result.isNotEmpty;
  }

  ChatMessage _messageFromMap(Map<String, dynamic> map) {
    Map<String, List<String>> reactions = {};
    final reactionsJson = map['reactions'] as String?;
    if (reactionsJson != null && reactionsJson.isNotEmpty) {
      final decoded = jsonDecode(reactionsJson) as Map<String, dynamic>;
      reactions = decoded.map((k, v) => MapEntry(k, (v as List).cast<String>()));
    }

    return ChatMessage(
      id: map['id'] as String,
      sessionId: map['session_id'] as String,
      text: map['text'] as String,
      timestamp: DateTime.fromMillisecondsSinceEpoch(map['timestamp'] as int),
      direction: MessageDirection.values.byName(map['direction'] as String),
      status: MessageStatus.values.byName(map['status'] as String),
      eventId: map['event_id'] as String?,
      replyToId: map['reply_to_id'] as String?,
      reactions: reactions,
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
      'reply_to_id': message.replyToId,
      'reactions': message.reactions.isEmpty ? null : jsonEncode(message.reactions),
    };
  }
}

import 'package:sqflite/sqflite.dart';

import '../../../../core/services/database_service.dart';
import '../../domain/models/session.dart';

/// Local data source for chat sessions.
class SessionLocalDatasource {
  SessionLocalDatasource(this._databaseService);

  final DatabaseService _databaseService;

  Future<Database> get _db => _databaseService.database;

  /// Get all sessions ordered by last message time.
  Future<List<ChatSession>> getAllSessions() async {
    final db = await _db;
    final maps = await db.query(
      'sessions',
      orderBy: 'last_message_at DESC, created_at DESC',
    );
    return maps.map(_sessionFromMap).toList();
  }

  /// Get a session by ID.
  Future<ChatSession?> getSession(String id) async {
    final db = await _db;
    final maps = await db.query(
      'sessions',
      where: 'id = ?',
      whereArgs: [id],
      limit: 1,
    );
    if (maps.isEmpty) return null;
    return _sessionFromMap(maps.first);
  }

  /// Insert or update a session.
  Future<void> saveSession(ChatSession session) async {
    final db = await _db;
    await db.insert(
      'sessions',
      _sessionToMap(session),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  /// Delete a session.
  Future<void> deleteSession(String id) async {
    final db = await _db;
    await db.delete('sessions', where: 'id = ?', whereArgs: [id]);
  }

  /// Update session metadata.
  Future<void> updateMetadata(
    String id, {
    DateTime? lastMessageAt,
    String? lastMessagePreview,
    int? unreadCount,
  }) async {
    final db = await _db;
    final updates = <String, dynamic>{};
    if (lastMessageAt != null) {
      updates['last_message_at'] = lastMessageAt.millisecondsSinceEpoch;
    }
    if (lastMessagePreview != null) {
      updates['last_message_preview'] = lastMessagePreview;
    }
    if (unreadCount != null) {
      updates['unread_count'] = unreadCount;
    }
    if (updates.isNotEmpty) {
      await db.update('sessions', updates, where: 'id = ?', whereArgs: [id]);
    }
  }

  /// Get the serialized state for a session.
  Future<String?> getSessionState(String id) async {
    final db = await _db;
    final maps = await db.query(
      'sessions',
      columns: ['serialized_state'],
      where: 'id = ?',
      whereArgs: [id],
      limit: 1,
    );
    if (maps.isEmpty) return null;
    return maps.first['serialized_state'] as String?;
  }

  /// Save the serialized state for a session.
  Future<void> saveSessionState(String id, String state) async {
    final db = await _db;
    await db.update(
      'sessions',
      {'serialized_state': state},
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  ChatSession _sessionFromMap(Map<String, dynamic> map) {
    return ChatSession(
      id: map['id'] as String,
      recipientPubkeyHex: map['recipient_pubkey_hex'] as String,
      recipientName: map['recipient_name'] as String?,
      createdAt: DateTime.fromMillisecondsSinceEpoch(map['created_at'] as int),
      lastMessageAt: map['last_message_at'] != null
          ? DateTime.fromMillisecondsSinceEpoch(map['last_message_at'] as int)
          : null,
      lastMessagePreview: map['last_message_preview'] as String?,
      unreadCount: map['unread_count'] as int? ?? 0,
      inviteId: map['invite_id'] as String?,
      isInitiator: (map['is_initiator'] as int? ?? 0) == 1,
      serializedState: map['serialized_state'] as String?,
    );
  }

  Map<String, dynamic> _sessionToMap(ChatSession session) {
    return {
      'id': session.id,
      'recipient_pubkey_hex': session.recipientPubkeyHex,
      'recipient_name': session.recipientName,
      'created_at': session.createdAt.millisecondsSinceEpoch,
      'last_message_at': session.lastMessageAt?.millisecondsSinceEpoch,
      'last_message_preview': session.lastMessagePreview,
      'unread_count': session.unreadCount,
      'invite_id': session.inviteId,
      'is_initiator': session.isInitiator ? 1 : 0,
      'serialized_state': session.serializedState,
    };
  }
}

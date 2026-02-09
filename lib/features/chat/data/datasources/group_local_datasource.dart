import 'dart:convert';

import 'package:sqflite/sqflite.dart';

import '../../../../core/services/database_service.dart';
import '../../domain/models/group.dart';
import '../../domain/models/message.dart';

/// Local data source for private group chats.
class GroupLocalDatasource {
  GroupLocalDatasource(this._databaseService);

  final DatabaseService _databaseService;

  Future<Database> get _db => _databaseService.database;

  /// Get all groups ordered by last message time.
  Future<List<ChatGroup>> getAllGroups() async {
    final db = await _db;
    final maps = await db.query(
      'groups',
      orderBy: 'last_message_at DESC, created_at DESC',
    );
    return maps.map(_groupFromMap).toList();
  }

  /// Get a group by ID.
  Future<ChatGroup?> getGroup(String id) async {
    final db = await _db;
    final maps = await db.query(
      'groups',
      where: 'id = ?',
      whereArgs: [id],
      limit: 1,
    );
    if (maps.isEmpty) return null;
    return _groupFromMap(maps.first);
  }

  /// Insert or update a group.
  Future<void> saveGroup(ChatGroup group) async {
    final db = await _db;
    await db.insert(
      'groups',
      _groupToMap(group),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  /// Delete a group.
  Future<void> deleteGroup(String id) async {
    final db = await _db;
    await db.delete('groups', where: 'id = ?', whereArgs: [id]);
  }

  /// Update group metadata.
  Future<void> updateMetadata(
    String id, {
    DateTime? lastMessageAt,
    String? lastMessagePreview,
    int? unreadCount,
    bool? accepted,
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
    if (accepted != null) {
      updates['accepted'] = accepted ? 1 : 0;
    }
    if (updates.isNotEmpty) {
      await db.update('groups', updates, where: 'id = ?', whereArgs: [id]);
    }
  }

  /// Recompute `last_message_*` and `unread_count` from the group_messages table.
  ///
  /// Useful after purging expired messages.
  Future<void> recomputeDerivedFieldsFromMessages(String id) async {
    final db = await _db;

    final last = await db.query(
      'group_messages',
      columns: ['text', 'timestamp'],
      where: 'group_id = ?',
      whereArgs: [id],
      orderBy: 'timestamp DESC',
      limit: 1,
    );

    final unreadResult = await db.rawQuery(
      'SELECT COUNT(*) as count FROM group_messages WHERE group_id = ? AND direction = ? AND status != ?',
      [id, MessageDirection.incoming.name, MessageStatus.seen.name],
    );
    final unread = Sqflite.firstIntValue(unreadResult) ?? 0;

    if (last.isEmpty) {
      await db.update(
        'groups',
        <String, Object?>{
          'last_message_at': null,
          'last_message_preview': null,
          'unread_count': unread,
        },
        where: 'id = ?',
        whereArgs: [id],
      );
      return;
    }

    final text = last.first['text']?.toString() ?? '';
    final preview = text.length > 50 ? '${text.substring(0, 50)}...' : text;
    final ts = last.first['timestamp'] as int?;

    await db.update(
      'groups',
      <String, Object?>{
        'last_message_at': ts,
        'last_message_preview': preview,
        'unread_count': unread,
      },
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  ChatGroup _groupFromMap(Map<String, dynamic> map) {
    final membersJson = map['members'] as String;
    final adminsJson = map['admins'] as String;

    return ChatGroup(
      id: map['id'] as String,
      name: map['name'] as String,
      description: map['description'] as String?,
      picture: map['picture'] as String?,
      members: (jsonDecode(membersJson) as List)
          .map((e) => e.toString())
          .toList(),
      admins: (jsonDecode(adminsJson) as List)
          .map((e) => e.toString())
          .toList(),
      createdAt: DateTime.fromMillisecondsSinceEpoch(map['created_at'] as int),
      secret: map['secret'] as String?,
      accepted: (map['accepted'] as int? ?? 0) == 1,
      lastMessageAt: map['last_message_at'] != null
          ? DateTime.fromMillisecondsSinceEpoch(map['last_message_at'] as int)
          : null,
      lastMessagePreview: map['last_message_preview'] as String?,
      unreadCount: map['unread_count'] as int? ?? 0,
    );
  }

  Map<String, dynamic> _groupToMap(ChatGroup group) {
    return {
      'id': group.id,
      'name': group.name,
      'description': group.description,
      'picture': group.picture,
      'members': jsonEncode(group.members),
      'admins': jsonEncode(group.admins),
      'created_at': group.createdAt.millisecondsSinceEpoch,
      'secret': group.secret,
      'accepted': group.accepted ? 1 : 0,
      'last_message_at': group.lastMessageAt?.millisecondsSinceEpoch,
      'last_message_preview': group.lastMessagePreview,
      'unread_count': group.unreadCount,
    };
  }
}

import 'dart:convert';

import 'package:sqflite/sqflite.dart';

import '../../../../core/services/database_service.dart';
import '../../domain/models/invite.dart';

/// Local data source for invites.
class InviteLocalDatasource {
  InviteLocalDatasource(this._databaseService);

  final DatabaseService _databaseService;

  Future<Database> get _db => _databaseService.database;

  /// Get all invites ordered by creation time.
  Future<List<Invite>> getAllInvites() async {
    final db = await _db;
    final maps = await db.query(
      'invites',
      orderBy: 'created_at DESC',
    );
    return maps.map(_inviteFromMap).toList();
  }

  /// Get active invites (can still be used).
  Future<List<Invite>> getActiveInvites() async {
    final db = await _db;
    final maps = await db.query(
      'invites',
      where: 'max_uses IS NULL OR use_count < max_uses',
      orderBy: 'created_at DESC',
    );
    return maps.map(_inviteFromMap).toList();
  }

  /// Get an invite by ID.
  Future<Invite?> getInvite(String id) async {
    final db = await _db;
    final maps = await db.query(
      'invites',
      where: 'id = ?',
      whereArgs: [id],
      limit: 1,
    );
    if (maps.isEmpty) return null;
    return _inviteFromMap(maps.first);
  }

  /// Save an invite.
  Future<void> saveInvite(Invite invite) async {
    final db = await _db;
    await db.insert(
      'invites',
      _inviteToMap(invite),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  /// Update an invite.
  Future<void> updateInvite(Invite invite) async {
    final db = await _db;
    await db.update(
      'invites',
      _inviteToMap(invite),
      where: 'id = ?',
      whereArgs: [invite.id],
    );
  }

  /// Delete an invite.
  Future<void> deleteInvite(String id) async {
    final db = await _db;
    await db.delete('invites', where: 'id = ?', whereArgs: [id]);
  }

  /// Mark an invite as used.
  Future<void> markUsed(String id, String acceptedByPubkey) async {
    final invite = await getInvite(id);
    if (invite == null) return;

    // Idempotency: relays can replay events and we can receive duplicates.
    // Don't inflate use counts or accepted_by with the same pubkey.
    if (invite.acceptedBy.contains(acceptedByPubkey)) return;

    final acceptedBy = [...invite.acceptedBy, acceptedByPubkey];

    final db = await _db;
    await db.update(
      'invites',
      {
        'use_count': invite.useCount + 1,
        'accepted_by': jsonEncode(acceptedBy),
      },
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  Invite _inviteFromMap(Map<String, dynamic> map) {
    List<String> acceptedBy = [];
    final acceptedByJson = map['accepted_by'] as String?;
    if (acceptedByJson != null && acceptedByJson.isNotEmpty) {
      acceptedBy = List<String>.from(jsonDecode(acceptedByJson) as List);
    }

    return Invite(
      id: map['id'] as String,
      inviterPubkeyHex: map['inviter_pubkey_hex'] as String,
      label: map['label'] as String?,
      createdAt: DateTime.fromMillisecondsSinceEpoch(map['created_at'] as int),
      maxUses: map['max_uses'] as int?,
      useCount: map['use_count'] as int? ?? 0,
      acceptedBy: acceptedBy,
      serializedState: map['serialized_state'] as String?,
    );
  }

  Map<String, dynamic> _inviteToMap(Invite invite) {
    return {
      'id': invite.id,
      'inviter_pubkey_hex': invite.inviterPubkeyHex,
      'label': invite.label,
      'created_at': invite.createdAt.millisecondsSinceEpoch,
      'max_uses': invite.maxUses,
      'use_count': invite.useCount,
      'accepted_by': jsonEncode(invite.acceptedBy),
      'serialized_state': invite.serializedState,
    };
  }
}

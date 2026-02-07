import 'dart:convert';
import 'dart:math';

import 'package:uuid/uuid.dart';

import '../models/group.dart';

/// Encrypted group metadata rumor kind (matches nostr-double-ratchet).
const int kGroupMetadataKind = 40;

/// Tag name used to associate a rumor/event with a group id.
const String kGroupTagName = 'l';

/// A parsed group metadata payload.
class GroupMetadata {
  const GroupMetadata({
    required this.id,
    required this.name,
    required this.members,
    required this.admins,
    this.description,
    this.picture,
    this.secret,
  });

  final String id;
  final String name;
  final String? description;
  final String? picture;
  final List<String> members;
  final List<String> admins;
  final String? secret;
}

enum MetadataValidation {
  accept,
  reject,
  removed,
}

bool isGroupAdmin(ChatGroup group, String pubkeyHex) {
  return group.admins.contains(pubkeyHex);
}

String generateGroupSecretHex() {
  final r = Random.secure();
  final bytes = List<int>.generate(32, (_) => r.nextInt(256));
  final sb = StringBuffer();
  for (final b in bytes) {
    sb.write(b.toRadixString(16).padLeft(2, '0'));
  }
  return sb.toString();
}

/// Create new group data for a local user initiating the group.
ChatGroup createGroupData({
  required String name,
  required String creatorPubkeyHex,
  required List<String> memberPubkeysHex,
}) {
  // Preserve order: creator first, then selected members, de-duplicated.
  final members = <String>[];
  final seen = <String>{};

  void add(String pk) {
    if (pk.isEmpty) return;
    if (!seen.add(pk)) return;
    members.add(pk);
  }

  add(creatorPubkeyHex);
  for (final pk in memberPubkeysHex) {
    if (pk == creatorPubkeyHex) continue;
    add(pk);
  }

  final now = DateTime.now();

  return ChatGroup(
    id: const Uuid().v4(),
    name: name,
    members: members,
    admins: [creatorPubkeyHex],
    createdAt: now,
    secret: generateGroupSecretHex(),
    accepted: true,
  );
}

String buildGroupMetadataContent(ChatGroup group, {bool excludeSecret = false}) {
  final m = <String, Object?>{
    'id': group.id,
    'name': group.name,
    'members': group.members,
    'admins': group.admins,
    if (group.description != null && group.description!.isNotEmpty)
      'description': group.description,
    if (group.picture != null && group.picture!.isNotEmpty) 'picture': group.picture,
    if (!excludeSecret && group.secret != null && group.secret!.isNotEmpty)
      'secret': group.secret,
  };

  return jsonEncode(m);
}

GroupMetadata? parseGroupMetadata(String content) {
  try {
    final decoded = jsonDecode(content);
    if (decoded is! Map<String, dynamic>) return null;

    final id = decoded['id'];
    final name = decoded['name'];
    if (id is! String || id.isEmpty) return null;
    if (name is! String || name.isEmpty) return null;

    final membersRaw = decoded['members'];
    final adminsRaw = decoded['admins'];
    if (membersRaw is! List) return null;
    if (adminsRaw is! List) return null;
    if (adminsRaw.isEmpty) return null;

    final members = <String>[];
    for (final v in membersRaw) {
      if (v is! String) return null;
      members.add(v);
    }

    final admins = <String>[];
    for (final v in adminsRaw) {
      if (v is! String) return null;
      admins.add(v);
    }

    final description = decoded['description'] is String
        ? (decoded['description'] as String)
        : null;
    final picture =
        decoded['picture'] is String ? (decoded['picture'] as String) : null;
    final secret =
        decoded['secret'] is String ? (decoded['secret'] as String) : null;

    return GroupMetadata(
      id: id,
      name: name,
      members: members,
      admins: admins,
      description: description,
      picture: picture,
      secret: secret,
    );
  } catch (_) {
    return null;
  }
}

bool validateMetadataCreation({
  required GroupMetadata metadata,
  required String senderPubkeyHex,
  required String myPubkeyHex,
}) {
  if (!metadata.admins.contains(senderPubkeyHex)) return false;
  if (!metadata.members.contains(myPubkeyHex)) return false;
  return true;
}

MetadataValidation validateMetadataUpdate({
  required ChatGroup existing,
  required GroupMetadata metadata,
  required String senderPubkeyHex,
  required String myPubkeyHex,
}) {
  if (!isGroupAdmin(existing, senderPubkeyHex)) {
    return MetadataValidation.reject;
  }
  if (!metadata.members.contains(myPubkeyHex)) {
    return MetadataValidation.removed;
  }
  return MetadataValidation.accept;
}

ChatGroup applyMetadataUpdate({
  required ChatGroup existing,
  required GroupMetadata metadata,
}) {
  return existing.copyWith(
    name: metadata.name,
    members: metadata.members,
    admins: metadata.admins,
    description: metadata.description,
    picture: metadata.picture,
    // Preserve existing secret if update omitted it.
    secret: metadata.secret ?? existing.secret,
  );
}


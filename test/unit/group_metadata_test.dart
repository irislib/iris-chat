import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:iris_chat/features/chat/domain/utils/group_metadata.dart';

void main() {
  group('group_metadata', () {
    final alice = 'a'.padRight(64, 'a');
    final bob = 'b'.padRight(64, 'b');
    final carol = 'c'.padRight(64, 'c');
    final x64 = 'x'.padRight(64, 'x');

    test('createGroupData puts creator first, de-duplicates, and marks accepted', () {
      final group = createGroupData(
        name: 'My Group',
        creatorPubkeyHex: alice,
        memberPubkeysHex: [alice, bob, carol, bob],
      );

      expect(group.name, 'My Group');
      expect(group.members, [alice, bob, carol]);
      expect(group.admins, [alice]);
      expect(group.accepted, true);
      expect(group.secret, isNotNull);
      expect(group.secret, hasLength(64));
    });

    test('buildGroupMetadataContent includes secret by default and excludes it when requested', () {
      final group = createGroupData(
        name: 'Secret Group',
        creatorPubkeyHex: alice,
        memberPubkeysHex: [bob],
      );

      final withSecret = jsonDecode(buildGroupMetadataContent(group)) as Map<String, dynamic>;
      expect(withSecret['id'], group.id);
      expect(withSecret['name'], group.name);
      expect(withSecret['members'], group.members);
      expect(withSecret['admins'], group.admins);
      expect(withSecret['secret'], group.secret);

      final noSecret = jsonDecode(buildGroupMetadataContent(group, excludeSecret: true)) as Map<String, dynamic>;
      expect(noSecret['secret'], isNull);
    });

    test('parseGroupMetadata parses valid metadata json', () {
      final jsonString =
          '{"id":"g1","name":"G","members":["$alice"],"admins":["$alice"],"secret":"$x64"}';
      final meta = parseGroupMetadata(jsonString);
      expect(meta, isNotNull);
      expect(meta!.id, 'g1');
      expect(meta.name, 'G');
      expect(meta.members, [alice]);
      expect(meta.admins, [alice]);
      expect(meta.secret, x64);
    });

    test('validateMetadataCreation requires sender to be admin and me to be in members', () {
      final meta = parseGroupMetadata(
        '{"id":"g1","name":"G","members":["$alice","$bob"],"admins":["$alice"]}',
      )!;

      expect(
        validateMetadataCreation(
          metadata: meta,
          senderPubkeyHex: alice,
          myPubkeyHex: bob,
        ),
        true,
      );

      expect(
        validateMetadataCreation(
          metadata: meta,
          senderPubkeyHex: bob,
          myPubkeyHex: bob,
        ),
        false,
      );

      expect(
        validateMetadataCreation(
          metadata: meta,
          senderPubkeyHex: alice,
          myPubkeyHex: carol,
        ),
        false,
      );
    });

    test('validateMetadataUpdate rejects non-admin, marks removed when me is not a member', () {
      final existing = createGroupData(
        name: 'G',
        creatorPubkeyHex: alice,
        memberPubkeysHex: [bob],
      );

      final meta = parseGroupMetadata(
        '{"id":"${existing.id}","name":"G","members":["$alice","$bob"],"admins":["$alice"]}',
      )!;

      expect(
        validateMetadataUpdate(
          existing: existing,
          metadata: meta,
          senderPubkeyHex: bob,
          myPubkeyHex: bob,
        ),
        MetadataValidation.reject,
      );

      final removedMeta = parseGroupMetadata(
        '{"id":"${existing.id}","name":"G","members":["$alice"],"admins":["$alice"]}',
      )!;
      expect(
        validateMetadataUpdate(
          existing: existing,
          metadata: removedMeta,
          senderPubkeyHex: alice,
          myPubkeyHex: bob,
        ),
        MetadataValidation.removed,
      );

      expect(
        validateMetadataUpdate(
          existing: existing,
          metadata: meta,
          senderPubkeyHex: alice,
          myPubkeyHex: bob,
        ),
        MetadataValidation.accept,
      );
    });

    test('applyMetadataUpdate preserves secret when update omits it', () {
      final existing = createGroupData(
        name: 'G',
        creatorPubkeyHex: alice,
        memberPubkeysHex: [bob],
      );
      final secret = existing.secret;
      expect(secret, isNotNull);

      final meta = parseGroupMetadata(
        '{"id":"${existing.id}","name":"New","members":["$alice","$bob"],"admins":["$alice"]}',
      )!;

      final updated = applyMetadataUpdate(existing: existing, metadata: meta);
      expect(updated.name, 'New');
      expect(updated.secret, secret);
    });
  });
}

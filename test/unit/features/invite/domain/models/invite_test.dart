import 'package:flutter_test/flutter_test.dart';

import 'package:iris_chat/features/invite/domain/models/invite.dart';

void main() {
  group('Invite', () {
    group('canBeUsed', () {
      test('returns true when maxUses is null', () {
        final invite = Invite(
          id: 'invite-1',
          inviterPubkeyHex: 'pubkey123',
          createdAt: DateTime.now(),
        );

        expect(invite.canBeUsed, true);
      });

      test('returns true when useCount is less than maxUses', () {
        final invite = Invite(
          id: 'invite-1',
          inviterPubkeyHex: 'pubkey123',
          createdAt: DateTime.now(),
          maxUses: 5,
          useCount: 3,
        );

        expect(invite.canBeUsed, true);
      });

      test('returns false when useCount equals maxUses', () {
        final invite = Invite(
          id: 'invite-1',
          inviterPubkeyHex: 'pubkey123',
          createdAt: DateTime.now(),
          maxUses: 5,
          useCount: 5,
        );

        expect(invite.canBeUsed, false);
      });

      test('returns false when useCount exceeds maxUses', () {
        final invite = Invite(
          id: 'invite-1',
          inviterPubkeyHex: 'pubkey123',
          createdAt: DateTime.now(),
          maxUses: 3,
          useCount: 4,
        );

        expect(invite.canBeUsed, false);
      });
    });

    group('isUsed', () {
      test('returns false when useCount is 0', () {
        final invite = Invite(
          id: 'invite-1',
          inviterPubkeyHex: 'pubkey123',
          createdAt: DateTime.now(),
          useCount: 0,
        );

        expect(invite.isUsed, false);
      });

      test('returns true when useCount is greater than 0', () {
        final invite = Invite(
          id: 'invite-1',
          inviterPubkeyHex: 'pubkey123',
          createdAt: DateTime.now(),
          useCount: 1,
        );

        expect(invite.isUsed, true);
      });
    });

    group('default values', () {
      test('useCount defaults to 0', () {
        final invite = Invite(
          id: 'invite-1',
          inviterPubkeyHex: 'pubkey123',
          createdAt: DateTime.now(),
        );

        expect(invite.useCount, 0);
      });

      test('acceptedBy defaults to empty list', () {
        final invite = Invite(
          id: 'invite-1',
          inviterPubkeyHex: 'pubkey123',
          createdAt: DateTime.now(),
        );

        expect(invite.acceptedBy, isEmpty);
      });

      test('label defaults to null', () {
        final invite = Invite(
          id: 'invite-1',
          inviterPubkeyHex: 'pubkey123',
          createdAt: DateTime.now(),
        );

        expect(invite.label, isNull);
      });

      test('maxUses defaults to null', () {
        final invite = Invite(
          id: 'invite-1',
          inviterPubkeyHex: 'pubkey123',
          createdAt: DateTime.now(),
        );

        expect(invite.maxUses, isNull);
      });
    });

    group('copyWith', () {
      test('updates useCount', () {
        final invite = Invite(
          id: 'invite-1',
          inviterPubkeyHex: 'pubkey123',
          createdAt: DateTime.now(),
          useCount: 0,
        );

        final updated = invite.copyWith(useCount: 5);

        expect(updated.useCount, 5);
        expect(updated.id, invite.id);
      });

      test('updates label', () {
        final invite = Invite(
          id: 'invite-1',
          inviterPubkeyHex: 'pubkey123',
          createdAt: DateTime.now(),
        );

        final updated = invite.copyWith(label: 'Work contacts');

        expect(updated.label, 'Work contacts');
      });

      test('updates acceptedBy', () {
        final invite = Invite(
          id: 'invite-1',
          inviterPubkeyHex: 'pubkey123',
          createdAt: DateTime.now(),
        );

        final updated = invite.copyWith(acceptedBy: ['user1', 'user2']);

        expect(updated.acceptedBy, ['user1', 'user2']);
      });
    });
  });

  group('InviteAcceptData', () {
    test('creates with required fields', () {
      const data = InviteAcceptData(
        sessionId: 'session-123',
        responseEventJson: '{"kind": 443}',
        inviterPubkeyHex: 'pubkey123',
      );

      expect(data.sessionId, 'session-123');
      expect(data.responseEventJson, '{"kind": 443}');
      expect(data.inviterPubkeyHex, 'pubkey123');
    });
  });
}

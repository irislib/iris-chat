import 'package:flutter_test/flutter_test.dart';

import 'package:iris_chat/features/chat/domain/models/session.dart';
import 'package:iris_chat/shared/utils/animal_names.dart';

void main() {
  group('ChatSession', () {
    group('displayName', () {
      test('returns recipientName when available', () {
        final session = ChatSession(
          id: 'session-1',
          recipientPubkeyHex: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
          recipientName: 'Alice',
          createdAt: DateTime.now(),
        );

        expect(session.displayName, 'Alice');
      });

      test('returns animal name when no name', () {
        final session = ChatSession(
          id: 'session-1',
          recipientPubkeyHex: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
          createdAt: DateTime.now(),
        );

        expect(
          session.displayName,
          getAnimalName(session.recipientPubkeyHex),
        );
      });

      test('returns animal name even if pubkey is short', () {
        final session = ChatSession(
          id: 'session-1',
          recipientPubkeyHex: 'short',
          createdAt: DateTime.now(),
        );

        expect(
          session.displayName,
          getAnimalName(session.recipientPubkeyHex),
        );
      });
    });

    group('default values', () {
      test('unreadCount defaults to 0', () {
        final session = ChatSession(
          id: 'session-1',
          recipientPubkeyHex: 'pubkey',
          createdAt: DateTime.now(),
        );

        expect(session.unreadCount, 0);
      });

      test('isInitiator defaults to false', () {
        final session = ChatSession(
          id: 'session-1',
          recipientPubkeyHex: 'pubkey',
          createdAt: DateTime.now(),
        );

        expect(session.isInitiator, false);
      });

      test('lastMessageAt is null by default', () {
        final session = ChatSession(
          id: 'session-1',
          recipientPubkeyHex: 'pubkey',
          createdAt: DateTime.now(),
        );

        expect(session.lastMessageAt, isNull);
      });

      test('lastMessagePreview is null by default', () {
        final session = ChatSession(
          id: 'session-1',
          recipientPubkeyHex: 'pubkey',
          createdAt: DateTime.now(),
        );

        expect(session.lastMessagePreview, isNull);
      });
    });

    group('copyWith', () {
      test('creates copy with updated fields', () {
        final original = ChatSession(
          id: 'session-1',
          recipientPubkeyHex: 'pubkey',
          createdAt: DateTime.now(),
          unreadCount: 0,
        );

        final updated = original.copyWith(
          unreadCount: 5,
          lastMessagePreview: 'Hello!',
        );

        expect(updated.id, original.id);
        expect(updated.recipientPubkeyHex, original.recipientPubkeyHex);
        expect(updated.unreadCount, 5);
        expect(updated.lastMessagePreview, 'Hello!');
      });

      test('preserves other fields when updating one', () {
        final timestamp = DateTime.now();
        final original = ChatSession(
          id: 'session-1',
          recipientPubkeyHex: 'pubkey',
          recipientName: 'Alice',
          createdAt: timestamp,
          inviteId: 'invite-1',
          isInitiator: true,
        );

        final updated = original.copyWith(unreadCount: 3);

        expect(updated.recipientName, 'Alice');
        expect(updated.inviteId, 'invite-1');
        expect(updated.isInitiator, true);
      });
    });
  });

  group('SessionStatus', () {
    test('has all expected values', () {
      expect(SessionStatus.values, contains(SessionStatus.active));
      expect(SessionStatus.values, contains(SessionStatus.pending));
      expect(SessionStatus.values, contains(SessionStatus.error));
    });
  });
}

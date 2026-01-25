import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:iris_chat/core/services/database_service.dart';
import 'package:iris_chat/features/invite/data/datasources/invite_local_datasource.dart';
import 'package:iris_chat/features/invite/domain/models/invite.dart';
import 'package:mocktail/mocktail.dart';
import 'package:sqflite/sqflite.dart';

class MockDatabaseService extends Mock implements DatabaseService {}

class MockDatabase extends Mock implements Database {}

void main() {
  late InviteLocalDatasource datasource;
  late MockDatabaseService mockDbService;
  late MockDatabase mockDb;

  setUp(() {
    mockDbService = MockDatabaseService();
    mockDb = MockDatabase();
    datasource = InviteLocalDatasource(mockDbService);

    when(() => mockDbService.database).thenAnswer((_) async => mockDb);
  });

  group('InviteLocalDatasource', () {
    group('getAllInvites', () {
      test('returns empty list when no invites', () async {
        when(() => mockDb.query(
              'invites',
              orderBy: 'created_at DESC',
            )).thenAnswer((_) async => []);

        final invites = await datasource.getAllInvites();

        expect(invites, isEmpty);
      });

      test('returns invites ordered by creation time', () async {
        final now = DateTime.now();
        when(() => mockDb.query(
              'invites',
              orderBy: 'created_at DESC',
            )).thenAnswer((_) async => [
              {
                'id': 'invite-1',
                'inviter_pubkey_hex': 'pubkey1',
                'label': 'Work',
                'created_at': now.millisecondsSinceEpoch,
                'max_uses': 5,
                'use_count': 2,
                'accepted_by': jsonEncode(['user1', 'user2']),
                'serialized_state': '{"state": "data"}',
              },
              {
                'id': 'invite-2',
                'inviter_pubkey_hex': 'pubkey1',
                'label': null,
                'created_at':
                    now.subtract(const Duration(days: 1)).millisecondsSinceEpoch,
                'max_uses': null,
                'use_count': 0,
                'accepted_by': null,
                'serialized_state': null,
              },
            ]);

        final invites = await datasource.getAllInvites();

        expect(invites.length, 2);
        expect(invites[0].id, 'invite-1');
        expect(invites[0].label, 'Work');
        expect(invites[0].maxUses, 5);
        expect(invites[0].useCount, 2);
        expect(invites[0].acceptedBy, ['user1', 'user2']);
        expect(invites[1].id, 'invite-2');
        expect(invites[1].label, isNull);
        expect(invites[1].maxUses, isNull);
        expect(invites[1].acceptedBy, isEmpty);
      });
    });

    group('getActiveInvites', () {
      test('filters out exhausted invites', () async {
        when(() => mockDb.query(
              'invites',
              where: 'max_uses IS NULL OR use_count < max_uses',
              orderBy: 'created_at DESC',
            )).thenAnswer((_) async => []);

        await datasource.getActiveInvites();

        verify(() => mockDb.query(
              'invites',
              where: 'max_uses IS NULL OR use_count < max_uses',
              orderBy: 'created_at DESC',
            )).called(1);
      });
    });

    group('getInvite', () {
      test('returns null when invite not found', () async {
        when(() => mockDb.query(
              'invites',
              where: 'id = ?',
              whereArgs: ['nonexistent'],
              limit: 1,
            )).thenAnswer((_) async => []);

        final invite = await datasource.getInvite('nonexistent');

        expect(invite, isNull);
      });

      test('returns invite when found', () async {
        final now = DateTime.now();
        when(() => mockDb.query(
              'invites',
              where: 'id = ?',
              whereArgs: ['invite-1'],
              limit: 1,
            )).thenAnswer((_) async => [
              {
                'id': 'invite-1',
                'inviter_pubkey_hex': 'pubkey1',
                'label': 'Friends',
                'created_at': now.millisecondsSinceEpoch,
                'max_uses': 10,
                'use_count': 1,
                'accepted_by': jsonEncode(['friend1']),
                'serialized_state': '{"invite": "state"}',
              },
            ]);

        final invite = await datasource.getInvite('invite-1');

        expect(invite, isNotNull);
        expect(invite!.id, 'invite-1');
        expect(invite.label, 'Friends');
        expect(invite.serializedState, '{"invite": "state"}');
      });
    });

    group('saveInvite', () {
      test('inserts invite with replace on conflict', () async {
        final invite = Invite(
          id: 'invite-1',
          inviterPubkeyHex: 'pubkey1',
          createdAt: DateTime.now(),
        );

        when(() => mockDb.insert(
              'invites',
              any(),
              conflictAlgorithm: ConflictAlgorithm.replace,
            )).thenAnswer((_) async => 1);

        await datasource.saveInvite(invite);

        verify(() => mockDb.insert(
              'invites',
              any(),
              conflictAlgorithm: ConflictAlgorithm.replace,
            )).called(1);
      });
    });

    group('updateInvite', () {
      test('updates invite by ID', () async {
        final invite = Invite(
          id: 'invite-1',
          inviterPubkeyHex: 'pubkey1',
          createdAt: DateTime.now(),
          label: 'Updated Label',
        );

        when(() => mockDb.update(
              'invites',
              any(),
              where: 'id = ?',
              whereArgs: ['invite-1'],
            )).thenAnswer((_) async => 1);

        await datasource.updateInvite(invite);

        verify(() => mockDb.update(
              'invites',
              any(),
              where: 'id = ?',
              whereArgs: ['invite-1'],
            )).called(1);
      });
    });

    group('deleteInvite', () {
      test('deletes invite by ID', () async {
        when(() => mockDb.delete(
              'invites',
              where: 'id = ?',
              whereArgs: ['invite-1'],
            )).thenAnswer((_) async => 1);

        await datasource.deleteInvite('invite-1');

        verify(() => mockDb.delete(
              'invites',
              where: 'id = ?',
              whereArgs: ['invite-1'],
            )).called(1);
      });
    });

    group('markUsed', () {
      test('increments use count and adds to acceptedBy', () async {
        final now = DateTime.now();

        // Mock getInvite
        when(() => mockDb.query(
              'invites',
              where: 'id = ?',
              whereArgs: ['invite-1'],
              limit: 1,
            )).thenAnswer((_) async => [
              {
                'id': 'invite-1',
                'inviter_pubkey_hex': 'pubkey1',
                'label': null,
                'created_at': now.millisecondsSinceEpoch,
                'max_uses': 5,
                'use_count': 1,
                'accepted_by': jsonEncode(['user1']),
                'serialized_state': null,
              },
            ]);

        when(() => mockDb.update(
              'invites',
              {
                'use_count': 2,
                'accepted_by': jsonEncode(['user1', 'user2']),
              },
              where: 'id = ?',
              whereArgs: ['invite-1'],
            )).thenAnswer((_) async => 1);

        await datasource.markUsed('invite-1', 'user2');

        verify(() => mockDb.update(
              'invites',
              {
                'use_count': 2,
                'accepted_by': jsonEncode(['user1', 'user2']),
              },
              where: 'id = ?',
              whereArgs: ['invite-1'],
            )).called(1);
      });

      test('does nothing when invite not found', () async {
        when(() => mockDb.query(
              'invites',
              where: 'id = ?',
              whereArgs: ['nonexistent'],
              limit: 1,
            )).thenAnswer((_) async => []);

        await datasource.markUsed('nonexistent', 'user1');

        verifyNever(() => mockDb.update(any(), any()));
      });
    });
  });
}

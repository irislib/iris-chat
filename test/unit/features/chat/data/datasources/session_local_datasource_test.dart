import 'package:flutter_test/flutter_test.dart';
import 'package:iris_chat/core/services/database_service.dart';
import 'package:iris_chat/features/chat/data/datasources/session_local_datasource.dart';
import 'package:iris_chat/features/chat/domain/models/session.dart';
import 'package:mocktail/mocktail.dart';
import 'package:sqflite/sqflite.dart';

class MockDatabaseService extends Mock implements DatabaseService {}

class MockDatabase extends Mock implements Database {}

void main() {
  late SessionLocalDatasource datasource;
  late MockDatabaseService mockDbService;
  late MockDatabase mockDb;

  setUp(() {
    mockDbService = MockDatabaseService();
    mockDb = MockDatabase();
    datasource = SessionLocalDatasource(mockDbService);

    when(() => mockDbService.database).thenAnswer((_) async => mockDb);
  });

  group('SessionLocalDatasource', () {
    group('getAllSessions', () {
      test('returns empty list when no sessions', () async {
        when(() => mockDb.query(
              'sessions',
              orderBy: any(named: 'orderBy'),
            )).thenAnswer((_) async => []);

        final sessions = await datasource.getAllSessions();

        expect(sessions, isEmpty);
      });

      test('returns sessions ordered by last message time', () async {
        final now = DateTime.now();
        when(() => mockDb.query(
              'sessions',
              orderBy: 'last_message_at DESC, created_at DESC',
            )).thenAnswer((_) async => [
              {
                'id': 'session-1',
                'recipient_pubkey_hex': 'pubkey1',
                'recipient_name': 'Alice',
                'created_at': now.millisecondsSinceEpoch,
                'last_message_at':
                    now.add(const Duration(hours: 1)).millisecondsSinceEpoch,
                'last_message_preview': 'Hello',
                'unread_count': 0,
                'invite_id': null,
                'is_initiator': 1,
                'serialized_state': null,
              },
              {
                'id': 'session-2',
                'recipient_pubkey_hex': 'pubkey2',
                'recipient_name': null,
                'created_at': now.millisecondsSinceEpoch,
                'last_message_at': null,
                'last_message_preview': null,
                'unread_count': 3,
                'invite_id': 'invite-1',
                'is_initiator': 0,
                'serialized_state': '{"state": "data"}',
              },
            ]);

        final sessions = await datasource.getAllSessions();

        expect(sessions.length, 2);
        expect(sessions[0].id, 'session-1');
        expect(sessions[0].recipientName, 'Alice');
        expect(sessions[0].isInitiator, true);
        expect(sessions[1].id, 'session-2');
        expect(sessions[1].recipientName, isNull);
        expect(sessions[1].unreadCount, 3);
        expect(sessions[1].serializedState, '{"state": "data"}');
      });
    });

    group('getSession', () {
      test('returns null when session not found', () async {
        when(() => mockDb.query(
              'sessions',
              where: 'id = ?',
              whereArgs: ['nonexistent'],
              limit: 1,
            )).thenAnswer((_) async => []);

        final session = await datasource.getSession('nonexistent');

        expect(session, isNull);
      });

      test('returns session when found', () async {
        final now = DateTime.now();
        when(() => mockDb.query(
              'sessions',
              where: 'id = ?',
              whereArgs: ['session-1'],
              limit: 1,
            )).thenAnswer((_) async => [
              {
                'id': 'session-1',
                'recipient_pubkey_hex': 'pubkey1',
                'recipient_name': 'Bob',
                'created_at': now.millisecondsSinceEpoch,
                'last_message_at': null,
                'last_message_preview': null,
                'unread_count': 0,
                'invite_id': null,
                'is_initiator': 0,
                'serialized_state': null,
              },
            ]);

        final session = await datasource.getSession('session-1');

        expect(session, isNotNull);
        expect(session!.id, 'session-1');
        expect(session.recipientName, 'Bob');
      });
    });

    group('saveSession', () {
      test('inserts session with replace on conflict', () async {
        final session = ChatSession(
          id: 'session-1',
          recipientPubkeyHex: 'pubkey1',
          createdAt: DateTime.now(),
        );

        when(() => mockDb.insert(
              'sessions',
              any(),
              conflictAlgorithm: ConflictAlgorithm.replace,
            )).thenAnswer((_) async => 1);

        await datasource.saveSession(session);

        verify(() => mockDb.insert(
              'sessions',
              any(),
              conflictAlgorithm: ConflictAlgorithm.replace,
            )).called(1);
      });
    });

    group('deleteSession', () {
      test('deletes session by ID', () async {
        when(() => mockDb.delete(
              'sessions',
              where: 'id = ?',
              whereArgs: ['session-1'],
            )).thenAnswer((_) async => 1);

        await datasource.deleteSession('session-1');

        verify(() => mockDb.delete(
              'sessions',
              where: 'id = ?',
              whereArgs: ['session-1'],
            )).called(1);
      });
    });

    group('updateMetadata', () {
      test('updates lastMessageAt', () async {
        final messageTime = DateTime.now();

        when(() => mockDb.update(
              'sessions',
              {'last_message_at': messageTime.millisecondsSinceEpoch},
              where: 'id = ?',
              whereArgs: ['session-1'],
            )).thenAnswer((_) async => 1);

        await datasource.updateMetadata(
          'session-1',
          lastMessageAt: messageTime,
        );

        verify(() => mockDb.update(
              'sessions',
              {'last_message_at': messageTime.millisecondsSinceEpoch},
              where: 'id = ?',
              whereArgs: ['session-1'],
            )).called(1);
      });

      test('updates unreadCount', () async {
        when(() => mockDb.update(
              'sessions',
              {'unread_count': 5},
              where: 'id = ?',
              whereArgs: ['session-1'],
            )).thenAnswer((_) async => 1);

        await datasource.updateMetadata('session-1', unreadCount: 5);

        verify(() => mockDb.update(
              'sessions',
              {'unread_count': 5},
              where: 'id = ?',
              whereArgs: ['session-1'],
            )).called(1);
      });

      test('does nothing when no updates provided', () async {
        await datasource.updateMetadata('session-1');

        verifyNever(() => mockDb.update(any(), any()));
      });
    });

    group('getSessionState', () {
      test('returns null when session not found', () async {
        when(() => mockDb.query(
              'sessions',
              columns: ['serialized_state'],
              where: 'id = ?',
              whereArgs: ['session-1'],
              limit: 1,
            )).thenAnswer((_) async => []);

        final state = await datasource.getSessionState('session-1');

        expect(state, isNull);
      });

      test('returns serialized state when found', () async {
        when(() => mockDb.query(
              'sessions',
              columns: ['serialized_state'],
              where: 'id = ?',
              whereArgs: ['session-1'],
              limit: 1,
            )).thenAnswer((_) async => [
              {'serialized_state': '{"ratchet": "data"}'},
            ]);

        final state = await datasource.getSessionState('session-1');

        expect(state, '{"ratchet": "data"}');
      });
    });

    group('saveSessionState', () {
      test('updates serialized state', () async {
        when(() => mockDb.update(
              'sessions',
              {'serialized_state': '{"new": "state"}'},
              where: 'id = ?',
              whereArgs: ['session-1'],
            )).thenAnswer((_) async => 1);

        await datasource.saveSessionState('session-1', '{"new": "state"}');

        verify(() => mockDb.update(
              'sessions',
              {'serialized_state': '{"new": "state"}'},
              where: 'id = ?',
              whereArgs: ['session-1'],
            )).called(1);
      });
    });
  });
}

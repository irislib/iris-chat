import 'package:flutter_test/flutter_test.dart';
import 'package:iris_chat/core/services/database_service.dart';
import 'package:iris_chat/features/chat/data/datasources/message_local_datasource.dart';
import 'package:iris_chat/features/chat/domain/models/message.dart';
import 'package:mocktail/mocktail.dart';
import 'package:sqflite/sqflite.dart';

class MockDatabaseService extends Mock implements DatabaseService {}

class MockDatabase extends Mock implements Database {}

void main() {
  late MessageLocalDatasource datasource;
  late MockDatabaseService mockDbService;
  late MockDatabase mockDb;

  setUp(() {
    mockDbService = MockDatabaseService();
    mockDb = MockDatabase();
    datasource = MessageLocalDatasource(mockDbService);

    when(() => mockDbService.database).thenAnswer((_) async => mockDb);
  });

  group('MessageLocalDatasource', () {
    group('getMessagesForSession', () {
      test('returns empty list when no messages', () async {
        when(() => mockDb.query(
              'messages',
              where: 'session_id = ?',
              whereArgs: ['session-1'],
              orderBy: 'timestamp DESC',
              limit: 50,
            )).thenAnswer((_) async => []);

        final messages = await datasource.getMessagesForSession(
          'session-1',
          limit: 50,
        );

        expect(messages, isEmpty);
      });

      test('returns messages in chronological order', () async {
        final now = DateTime.now();
        when(() => mockDb.query(
              'messages',
              where: 'session_id = ?',
              whereArgs: ['session-1'],
              orderBy: 'timestamp DESC',
              limit: 50,
            )).thenAnswer((_) async => [
              // Returned in DESC order from DB
              {
                'id': 'msg-2',
                'session_id': 'session-1',
                'text': 'Second',
                'timestamp':
                    now.add(const Duration(minutes: 1)).millisecondsSinceEpoch,
                'direction': 'incoming',
                'status': 'delivered',
                'event_id': 'event-2',
                'reply_to_id': null,
              },
              {
                'id': 'msg-1',
                'session_id': 'session-1',
                'text': 'First',
                'timestamp': now.millisecondsSinceEpoch,
                'direction': 'outgoing',
                'status': 'sent',
                'event_id': 'event-1',
                'reply_to_id': null,
              },
            ]);

        final messages = await datasource.getMessagesForSession(
          'session-1',
          limit: 50,
        );

        // Should be reversed to chronological order
        expect(messages.length, 2);
        expect(messages[0].id, 'msg-1'); // First message
        expect(messages[1].id, 'msg-2'); // Second message
      });

      test('parses message fields correctly', () async {
        final timestamp = DateTime.now();
        when(() => mockDb.query(
              'messages',
              where: 'session_id = ?',
              whereArgs: ['session-1'],
              orderBy: 'timestamp DESC',
              limit: any(named: 'limit'),
            )).thenAnswer((_) async => [
              {
                'id': 'msg-1',
                'session_id': 'session-1',
                'text': 'Hello!',
                'timestamp': timestamp.millisecondsSinceEpoch,
                'direction': 'outgoing',
                'status': 'pending',
                'event_id': null,
                'reply_to_id': 'parent-msg',
              },
            ]);

        final messages = await datasource.getMessagesForSession('session-1');

        expect(messages.first.id, 'msg-1');
        expect(messages.first.text, 'Hello!');
        expect(messages.first.direction, MessageDirection.outgoing);
        expect(messages.first.status, MessageStatus.pending);
        expect(messages.first.eventId, isNull);
        expect(messages.first.replyToId, 'parent-msg');
      });
    });

    group('saveMessage', () {
      test('inserts message with replace on conflict', () async {
        final message = ChatMessage(
          id: 'msg-1',
          sessionId: 'session-1',
          text: 'Hello',
          timestamp: DateTime.now(),
          direction: MessageDirection.outgoing,
          status: MessageStatus.pending,
        );

        when(() => mockDb.insert(
              'messages',
              any(),
              conflictAlgorithm: ConflictAlgorithm.replace,
            )).thenAnswer((_) async => 1);

        await datasource.saveMessage(message);

        verify(() => mockDb.insert(
              'messages',
              any(),
              conflictAlgorithm: ConflictAlgorithm.replace,
            )).called(1);
      });
    });

    group('updateMessageStatus', () {
      test('updates status by ID', () async {
        when(() => mockDb.update(
              'messages',
              {'status': 'sent'},
              where: 'id = ?',
              whereArgs: ['msg-1'],
            )).thenAnswer((_) async => 1);

        await datasource.updateMessageStatus('msg-1', MessageStatus.sent);

        verify(() => mockDb.update(
              'messages',
              {'status': 'sent'},
              where: 'id = ?',
              whereArgs: ['msg-1'],
            )).called(1);
      });

      test('updates to failed status', () async {
        when(() => mockDb.update(
              'messages',
              {'status': 'failed'},
              where: 'id = ?',
              whereArgs: ['msg-1'],
            )).thenAnswer((_) async => 1);

        await datasource.updateMessageStatus('msg-1', MessageStatus.failed);

        verify(() => mockDb.update(
              'messages',
              {'status': 'failed'},
              where: 'id = ?',
              whereArgs: ['msg-1'],
            )).called(1);
      });
    });

    group('deleteMessage', () {
      test('deletes message by ID', () async {
        when(() => mockDb.delete(
              'messages',
              where: 'id = ?',
              whereArgs: ['msg-1'],
            )).thenAnswer((_) async => 1);

        await datasource.deleteMessage('msg-1');

        verify(() => mockDb.delete(
              'messages',
              where: 'id = ?',
              whereArgs: ['msg-1'],
            )).called(1);
      });
    });

    group('deleteMessagesForSession', () {
      test('deletes all messages for session', () async {
        when(() => mockDb.delete(
              'messages',
              where: 'session_id = ?',
              whereArgs: ['session-1'],
            )).thenAnswer((_) async => 5);

        await datasource.deleteMessagesForSession('session-1');

        verify(() => mockDb.delete(
              'messages',
              where: 'session_id = ?',
              whereArgs: ['session-1'],
            )).called(1);
      });
    });

    group('messageExists', () {
      test('returns true when message with eventId exists', () async {
        when(() => mockDb.query(
              'messages',
              columns: ['id'],
              where: 'event_id = ?',
              whereArgs: ['event-123'],
              limit: 1,
            )).thenAnswer((_) async => [
              {'id': 'msg-1'},
            ]);

        final exists = await datasource.messageExists('event-123');

        expect(exists, true);
      });

      test('returns false when message with eventId does not exist', () async {
        when(() => mockDb.query(
              'messages',
              columns: ['id'],
              where: 'event_id = ?',
              whereArgs: ['nonexistent'],
              limit: 1,
            )).thenAnswer((_) async => []);

        final exists = await datasource.messageExists('nonexistent');

        expect(exists, false);
      });
    });
  });
}

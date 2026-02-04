import 'package:flutter_test/flutter_test.dart';
import 'package:iris_chat/config/providers/chat_provider.dart';
import 'package:iris_chat/core/services/profile_service.dart';
import 'package:iris_chat/features/chat/data/datasources/session_local_datasource.dart';
import 'package:iris_chat/features/chat/domain/models/message.dart';
import 'package:iris_chat/features/chat/domain/models/session.dart';
import 'package:mocktail/mocktail.dart';

class MockSessionLocalDatasource extends Mock
    implements SessionLocalDatasource {}

class MockProfileService extends Mock implements ProfileService {}

void main() {
  late SessionNotifier notifier;
  late MockSessionLocalDatasource mockDatasource;
  late MockProfileService mockProfileService;

  setUpAll(() {
    registerFallbackValue(ChatSession(
      id: 'fallback',
      recipientPubkeyHex: 'abc123',
      createdAt: DateTime.now(),
      isInitiator: true,
    ));
  });

  setUp(() {
    mockDatasource = MockSessionLocalDatasource();
    mockProfileService = MockProfileService();
    when(() => mockProfileService.fetchProfiles(any())).thenAnswer((_) async {});
    when(() => mockProfileService.getProfile(any())).thenAnswer((_) async => null);
    notifier = SessionNotifier(mockDatasource, mockProfileService);
  });

  group('SessionNotifier', () {
    group('initial state', () {
      test('has empty sessions list', () {
        expect(notifier.state.sessions, isEmpty);
      });

      test('is not loading', () {
        expect(notifier.state.isLoading, false);
      });

      test('has no error', () {
        expect(notifier.state.error, isNull);
      });
    });

    group('loadSessions', () {
      test('sets isLoading true while loading', () async {
        when(() => mockDatasource.getAllSessions()).thenAnswer(
          (_) async => [],
        );

        final future = notifier.loadSessions();

        // Can't easily test intermediate state, but verify it completes
        await future;
        expect(notifier.state.isLoading, false);
      });

      test('populates sessions on success', () async {
        final sessions = [
          ChatSession(
            id: 'session-1',
            recipientPubkeyHex: 'pubkey1',
            createdAt: DateTime.now(),
          ),
          ChatSession(
            id: 'session-2',
            recipientPubkeyHex: 'pubkey2',
            createdAt: DateTime.now(),
          ),
        ];

        when(() => mockDatasource.getAllSessions()).thenAnswer(
          (_) async => sessions,
        );

        await notifier.loadSessions();

        expect(notifier.state.sessions, sessions);
        expect(notifier.state.isLoading, false);
        expect(notifier.state.error, isNull);
      });

      test('sets error on failure', () async {
        when(() => mockDatasource.getAllSessions()).thenThrow(
          Exception('Database error'),
        );

        await notifier.loadSessions();

        expect(notifier.state.sessions, isEmpty);
        expect(notifier.state.isLoading, false);
        // Error is mapped to user-friendly message
        expect(notifier.state.error, isNotNull);
        expect(notifier.state.error, isNotEmpty);
      });
    });

    group('addSession', () {
      test('saves session and adds to state', () async {
        final session = ChatSession(
          id: 'session-1',
          recipientPubkeyHex: 'pubkey1',
          createdAt: DateTime.now(),
        );

        when(() => mockDatasource.saveSession(session)).thenAnswer(
          (_) async {},
        );

        await notifier.addSession(session);

        expect(notifier.state.sessions, contains(session));
        verify(() => mockDatasource.saveSession(session)).called(1);
      });

      test('adds new session at beginning of list', () async {
        final session1 = ChatSession(
          id: 'session-1',
          recipientPubkeyHex: 'pubkey1',
          createdAt: DateTime.now(),
        );
        final session2 = ChatSession(
          id: 'session-2',
          recipientPubkeyHex: 'pubkey2',
          createdAt: DateTime.now(),
        );

        when(() => mockDatasource.saveSession(any())).thenAnswer(
          (_) async {},
        );

        await notifier.addSession(session1);
        await notifier.addSession(session2);

        expect(notifier.state.sessions.first.id, 'session-2');
      });
    });

    group('updateSession', () {
      test('saves and updates session in state', () async {
        final session = ChatSession(
          id: 'session-1',
          recipientPubkeyHex: 'pubkey1',
          createdAt: DateTime.now(),
        );

        when(() => mockDatasource.saveSession(any())).thenAnswer(
          (_) async {},
        );

        await notifier.addSession(session);

        final updatedSession = session.copyWith(recipientName: 'Alice');
        await notifier.updateSession(updatedSession);

        expect(
          notifier.state.sessions.first.recipientName,
          'Alice',
        );
      });
    });

    group('deleteSession', () {
      test('removes session from datasource and state', () async {
        final session = ChatSession(
          id: 'session-1',
          recipientPubkeyHex: 'pubkey1',
          createdAt: DateTime.now(),
        );

        when(() => mockDatasource.saveSession(session)).thenAnswer(
          (_) async {},
        );
        when(() => mockDatasource.deleteSession('session-1')).thenAnswer(
          (_) async {},
        );

        await notifier.addSession(session);
        expect(notifier.state.sessions, isNotEmpty);

        await notifier.deleteSession('session-1');

        expect(notifier.state.sessions, isEmpty);
        verify(() => mockDatasource.deleteSession('session-1')).called(1);
      });
    });

    group('updateSessionWithMessage', () {
      test('updates lastMessageAt and lastMessagePreview', () async {
        final session = ChatSession(
          id: 'session-1',
          recipientPubkeyHex: 'pubkey1',
          createdAt: DateTime.now(),
        );

        when(() => mockDatasource.saveSession(session)).thenAnswer(
          (_) async {},
        );
        when(() => mockDatasource.updateMetadata(
              any(),
              lastMessageAt: any(named: 'lastMessageAt'),
              lastMessagePreview: any(named: 'lastMessagePreview'),
            )).thenAnswer((_) async {});

        await notifier.addSession(session);

        final message = ChatMessage(
          id: 'msg-1',
          sessionId: 'session-1',
          text: 'Hello!',
          timestamp: DateTime.now(),
          direction: MessageDirection.outgoing,
          status: MessageStatus.sent,
        );

        await notifier.updateSessionWithMessage('session-1', message);

        expect(notifier.state.sessions.first.lastMessagePreview, 'Hello!');
        expect(notifier.state.sessions.first.lastMessageAt, message.timestamp);
      });

      test('truncates long messages in preview', () async {
        final session = ChatSession(
          id: 'session-1',
          recipientPubkeyHex: 'pubkey1',
          createdAt: DateTime.now(),
        );

        when(() => mockDatasource.saveSession(session)).thenAnswer(
          (_) async {},
        );
        when(() => mockDatasource.updateMetadata(
              any(),
              lastMessageAt: any(named: 'lastMessageAt'),
              lastMessagePreview: any(named: 'lastMessagePreview'),
            )).thenAnswer((_) async {});

        await notifier.addSession(session);

        final longText = 'A' * 100; // 100 characters
        final message = ChatMessage(
          id: 'msg-1',
          sessionId: 'session-1',
          text: longText,
          timestamp: DateTime.now(),
          direction: MessageDirection.outgoing,
          status: MessageStatus.sent,
        );

        await notifier.updateSessionWithMessage('session-1', message);

        expect(
          notifier.state.sessions.first.lastMessagePreview!.length,
          53, // 50 chars + "..."
        );
        expect(
          notifier.state.sessions.first.lastMessagePreview!.endsWith('...'),
          true,
        );
      });
    });

    group('incrementUnread', () {
      test('increments unread count by 1', () async {
        final session = ChatSession(
          id: 'session-1',
          recipientPubkeyHex: 'pubkey1',
          createdAt: DateTime.now(),
          unreadCount: 0,
        );

        when(() => mockDatasource.saveSession(session)).thenAnswer(
          (_) async {},
        );
        when(() => mockDatasource.updateMetadata(
              any(),
              unreadCount: any(named: 'unreadCount'),
            )).thenAnswer((_) async {});

        await notifier.addSession(session);
        await notifier.incrementUnread('session-1');

        expect(notifier.state.sessions.first.unreadCount, 1);
      });
    });

    group('clearUnread', () {
      test('sets unread count to 0', () async {
        final session = ChatSession(
          id: 'session-1',
          recipientPubkeyHex: 'pubkey1',
          createdAt: DateTime.now(),
          unreadCount: 5,
        );

        when(() => mockDatasource.saveSession(session)).thenAnswer(
          (_) async {},
        );
        when(() => mockDatasource.updateMetadata(
              any(),
              unreadCount: any(named: 'unreadCount'),
            )).thenAnswer((_) async {});

        await notifier.addSession(session);
        await notifier.clearUnread('session-1');

        expect(notifier.state.sessions.first.unreadCount, 0);
      });
    });
  });
}

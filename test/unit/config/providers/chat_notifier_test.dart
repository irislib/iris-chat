import 'package:flutter_test/flutter_test.dart';
import 'package:iris_chat/config/providers/chat_provider.dart';
import 'package:iris_chat/core/services/session_manager_service.dart';
import 'package:iris_chat/features/chat/data/datasources/message_local_datasource.dart';
import 'package:iris_chat/features/chat/data/datasources/session_local_datasource.dart';
import 'package:iris_chat/features/chat/domain/models/message.dart';
import 'package:mocktail/mocktail.dart';

class MockMessageLocalDatasource extends Mock
    implements MessageLocalDatasource {}

class MockSessionLocalDatasource extends Mock
    implements SessionLocalDatasource {}

class MockSessionManagerService extends Mock implements SessionManagerService {}

void main() {
  late ChatNotifier notifier;
  late MockMessageLocalDatasource mockMessageDatasource;
  late MockSessionLocalDatasource mockSessionDatasource;
  late MockSessionManagerService mockSessionManagerService;

  setUp(() {
    mockMessageDatasource = MockMessageLocalDatasource();
    mockSessionDatasource = MockSessionLocalDatasource();
    mockSessionManagerService = MockSessionManagerService();
    notifier = ChatNotifier(
      mockMessageDatasource,
      mockSessionDatasource,
      mockSessionManagerService,
    );
  });

  setUpAll(() {
    registerFallbackValue(ChatMessage(
      id: 'fallback',
      sessionId: 'session',
      text: 'text',
      timestamp: DateTime.now(),
      direction: MessageDirection.outgoing,
      status: MessageStatus.pending,
    ));
    registerFallbackValue(MessageStatus.pending);
  });

  group('ChatNotifier', () {
    group('initial state', () {
      test('has empty messages map', () {
        expect(notifier.state.messages, isEmpty);
      });

      test('has empty unreadCounts map', () {
        expect(notifier.state.unreadCounts, isEmpty);
      });

      test('has empty sendingStates map', () {
        expect(notifier.state.sendingStates, isEmpty);
      });

      test('has no error', () {
        expect(notifier.state.error, isNull);
      });
    });

    group('loadMessages', () {
      test('loads messages for a session', () async {
        final messages = [
          ChatMessage(
            id: 'msg-1',
            sessionId: 'session-1',
            text: 'Hello',
            timestamp: DateTime.now(),
            direction: MessageDirection.outgoing,
            status: MessageStatus.sent,
          ),
          ChatMessage(
            id: 'msg-2',
            sessionId: 'session-1',
            text: 'Hi there',
            timestamp: DateTime.now(),
            direction: MessageDirection.incoming,
            status: MessageStatus.delivered,
          ),
        ];

        when(() => mockMessageDatasource.getMessagesForSession(
              'session-1',
              limit: any(named: 'limit'),
            )).thenAnswer((_) async => messages);

        await notifier.loadMessages('session-1');

        expect(notifier.state.messages['session-1'], messages);
      });

      test('sets error on failure', () async {
        when(() => mockMessageDatasource.getMessagesForSession(
              any(),
              limit: any(named: 'limit'),
            )).thenThrow(Exception('Load failed'));

        await notifier.loadMessages('session-1');

        // Error is mapped to user-friendly message
        expect(notifier.state.error, isNotNull);
        expect(notifier.state.error, isNotEmpty);
      });
    });

    group('addMessageOptimistic', () {
      test('adds message to session messages', () {
        final message = ChatMessage(
          id: 'msg-1',
          sessionId: 'session-1',
          text: 'Hello',
          timestamp: DateTime.now(),
          direction: MessageDirection.outgoing,
          status: MessageStatus.pending,
        );

        notifier.addMessageOptimistic(message);

        expect(notifier.state.messages['session-1'], contains(message));
      });

      test('sets sending state for message', () {
        final message = ChatMessage(
          id: 'msg-1',
          sessionId: 'session-1',
          text: 'Hello',
          timestamp: DateTime.now(),
          direction: MessageDirection.outgoing,
          status: MessageStatus.pending,
        );

        notifier.addMessageOptimistic(message);

        expect(notifier.state.sendingStates['msg-1'], true);
      });

      test('appends to existing messages', () {
        final message1 = ChatMessage(
          id: 'msg-1',
          sessionId: 'session-1',
          text: 'First',
          timestamp: DateTime.now(),
          direction: MessageDirection.outgoing,
          status: MessageStatus.sent,
        );
        final message2 = ChatMessage(
          id: 'msg-2',
          sessionId: 'session-1',
          text: 'Second',
          timestamp: DateTime.now(),
          direction: MessageDirection.outgoing,
          status: MessageStatus.pending,
        );

        notifier.addMessageOptimistic(message1);
        notifier.addMessageOptimistic(message2);

        expect(notifier.state.messages['session-1']!.length, 2);
        expect(notifier.state.messages['session-1']!.last.id, 'msg-2');
      });
    });

    group('updateMessage', () {
      test('updates message in state and saves to datasource', () async {
        final message = ChatMessage(
          id: 'msg-1',
          sessionId: 'session-1',
          text: 'Hello',
          timestamp: DateTime.now(),
          direction: MessageDirection.outgoing,
          status: MessageStatus.pending,
        );

        when(() => mockMessageDatasource.saveMessage(any())).thenAnswer(
          (_) async {},
        );

        notifier.addMessageOptimistic(message);

        final updatedMessage = message.copyWith(status: MessageStatus.sent);
        await notifier.updateMessage(updatedMessage);

        expect(
          notifier.state.messages['session-1']!.first.status,
          MessageStatus.sent,
        );
        verify(() => mockMessageDatasource.saveMessage(updatedMessage))
            .called(1);
      });

      test('removes message from sendingStates', () async {
        final message = ChatMessage(
          id: 'msg-1',
          sessionId: 'session-1',
          text: 'Hello',
          timestamp: DateTime.now(),
          direction: MessageDirection.outgoing,
          status: MessageStatus.pending,
        );

        when(() => mockMessageDatasource.saveMessage(any())).thenAnswer(
          (_) async {},
        );

        notifier.addMessageOptimistic(message);
        expect(notifier.state.sendingStates.containsKey('msg-1'), true);

        await notifier.updateMessage(message.copyWith(status: MessageStatus.sent));

        expect(notifier.state.sendingStates.containsKey('msg-1'), false);
      });
    });

    group('addReceivedMessage', () {
      test('adds new message to state', () async {
        final message = ChatMessage(
          id: 'msg-1',
          sessionId: 'session-1',
          text: 'Hello from friend',
          timestamp: DateTime.now(),
          direction: MessageDirection.incoming,
          status: MessageStatus.delivered,
        );

        when(() => mockMessageDatasource.messageExists(any())).thenAnswer(
          (_) async => false,
        );
        when(() => mockMessageDatasource.saveMessage(any())).thenAnswer(
          (_) async {},
        );

        await notifier.addReceivedMessage(message);

        expect(notifier.state.messages['session-1'], contains(message));
        verify(() => mockMessageDatasource.saveMessage(message)).called(1);
      });

      test('skips duplicate messages with eventId', () async {
        final message = ChatMessage(
          id: 'msg-1',
          sessionId: 'session-1',
          text: 'Hello',
          timestamp: DateTime.now(),
          direction: MessageDirection.incoming,
          status: MessageStatus.delivered,
          eventId: 'event-123',
        );

        when(() => mockMessageDatasource.messageExists('event-123')).thenAnswer(
          (_) async => true,
        );

        await notifier.addReceivedMessage(message);

        expect(notifier.state.messages['session-1'], isNull);
        verifyNever(() => mockMessageDatasource.saveMessage(any()));
      });
    });

    group('updateMessageStatus', () {
      test('updates status of specific message', () async {
        final message = ChatMessage(
          id: 'msg-1',
          sessionId: 'session-1',
          text: 'Hello',
          timestamp: DateTime.now(),
          direction: MessageDirection.outgoing,
          status: MessageStatus.sent,
        );

        when(() => mockMessageDatasource.updateMessageStatus(
              any(),
              any(),
            )).thenAnswer((_) async {});
        when(() => mockMessageDatasource.saveMessage(any())).thenAnswer(
          (_) async {},
        );

        notifier.addMessageOptimistic(message);

        await notifier.updateMessageStatus('msg-1', MessageStatus.delivered);

        expect(
          notifier.state.messages['session-1']!.first.status,
          MessageStatus.delivered,
        );
      });
    });

    group('clearError', () {
      test('clears error state', () async {
        when(() => mockMessageDatasource.getMessagesForSession(
              any(),
              limit: any(named: 'limit'),
            )).thenThrow(Exception('Error'));

        await notifier.loadMessages('session-1');
        expect(notifier.state.error, isNotNull);

        notifier.clearError();

        expect(notifier.state.error, isNull);
      });
    });

    group('loadMoreMessages', () {
      test('loads messages before oldest message', () async {
        final existingMessages = [
          ChatMessage(
            id: 'msg-2',
            sessionId: 'session-1',
            text: 'Second',
            timestamp: DateTime.now(),
            direction: MessageDirection.outgoing,
            status: MessageStatus.sent,
          ),
        ];

        final olderMessages = [
          ChatMessage(
            id: 'msg-1',
            sessionId: 'session-1',
            text: 'First',
            timestamp: DateTime.now().subtract(const Duration(hours: 1)),
            direction: MessageDirection.incoming,
            status: MessageStatus.delivered,
          ),
        ];

        when(() => mockMessageDatasource.getMessagesForSession(
              'session-1',
              limit: any(named: 'limit'),
            )).thenAnswer((_) async => existingMessages);

        when(() => mockMessageDatasource.getMessagesForSession(
              'session-1',
              limit: any(named: 'limit'),
              beforeId: 'msg-2',
            )).thenAnswer((_) async => olderMessages);

        await notifier.loadMessages('session-1');
        await notifier.loadMoreMessages('session-1');

        final messages = notifier.state.messages['session-1']!;
        expect(messages.length, 2);
        expect(messages.first.id, 'msg-1');
        expect(messages.last.id, 'msg-2');
      });

      test('calls loadMessages when no existing messages', () async {
        when(() => mockMessageDatasource.getMessagesForSession(
              'session-1',
              limit: any(named: 'limit'),
            )).thenAnswer((_) async => []);

        await notifier.loadMoreMessages('session-1');

        verify(() => mockMessageDatasource.getMessagesForSession(
              'session-1',
              limit: any(named: 'limit'),
            )).called(1);
      });
    });
  });
}

import 'package:flutter_test/flutter_test.dart';

import 'package:iris_chat/features/chat/domain/models/message.dart';

void main() {
  group('ChatMessage', () {
    group('outgoing factory', () {
      test('creates message with pending status', () {
        final message = ChatMessage.outgoing(
          sessionId: 'session-1',
          text: 'Hello',
        );

        expect(message.sessionId, 'session-1');
        expect(message.text, 'Hello');
        expect(message.direction, MessageDirection.outgoing);
        expect(message.status, MessageStatus.pending);
        expect(message.id, isNotEmpty);
        expect(message.timestamp, isNotNull);
      });

      test('includes replyToId when provided', () {
        final message = ChatMessage.outgoing(
          sessionId: 'session-1',
          text: 'Reply',
          replyToId: 'original-msg-id',
        );

        expect(message.replyToId, 'original-msg-id');
      });
    });

    group('incoming factory', () {
      test('creates message with delivered status', () {
        final message = ChatMessage.incoming(
          sessionId: 'session-1',
          text: 'Hi there',
          eventId: 'event-123',
          rumorId: 'rumor-123',
        );

        expect(message.sessionId, 'session-1');
        expect(message.text, 'Hi there');
        expect(message.direction, MessageDirection.incoming);
        expect(message.status, MessageStatus.delivered);
        expect(message.eventId, 'event-123');
        expect(message.id, 'rumor-123'); // Uses stable rumor id as id
      });

      test('uses provided timestamp', () {
        final timestamp = DateTime(2024, 1, 15, 10, 30);
        final message = ChatMessage.incoming(
          sessionId: 'session-1',
          text: 'Hi',
          eventId: 'event-123',
          rumorId: 'rumor-123',
          timestamp: timestamp,
        );

        expect(message.timestamp, timestamp);
      });

      test('uses current time when timestamp not provided', () {
        final before = DateTime.now();
        final message = ChatMessage.incoming(
          sessionId: 'session-1',
          text: 'Hi',
          eventId: 'event-123',
          rumorId: 'rumor-123',
        );
        final after = DateTime.now();

        expect(message.timestamp.isAfter(before.subtract(const Duration(seconds: 1))), true);
        expect(message.timestamp.isBefore(after.add(const Duration(seconds: 1))), true);
      });
    });

    group('properties', () {
      test('isOutgoing returns true for outgoing messages', () {
        final message = ChatMessage.outgoing(
          sessionId: 'session-1',
          text: 'Hello',
        );

        expect(message.isOutgoing, true);
        expect(message.isIncoming, false);
      });

      test('isIncoming returns true for incoming messages', () {
        final message = ChatMessage.incoming(
          sessionId: 'session-1',
          text: 'Hi',
          eventId: 'event-123',
          rumorId: 'rumor-123',
        );

        expect(message.isIncoming, true);
        expect(message.isOutgoing, false);
      });

      test('isSent returns true for sent status', () {
        final message = ChatMessage(
          id: '1',
          sessionId: 'session-1',
          text: 'Hello',
          timestamp: DateTime.now(),
          direction: MessageDirection.outgoing,
          status: MessageStatus.sent,
        );

        expect(message.isSent, true);
      });

      test('isSent returns true for delivered status', () {
        final message = ChatMessage(
          id: '1',
          sessionId: 'session-1',
          text: 'Hello',
          timestamp: DateTime.now(),
          direction: MessageDirection.outgoing,
          status: MessageStatus.delivered,
        );

        expect(message.isSent, true);
      });

      test('isSent returns false for pending status', () {
        final message = ChatMessage(
          id: '1',
          sessionId: 'session-1',
          text: 'Hello',
          timestamp: DateTime.now(),
          direction: MessageDirection.outgoing,
          status: MessageStatus.pending,
        );

        expect(message.isSent, false);
      });

      test('isSent returns false for failed status', () {
        final message = ChatMessage(
          id: '1',
          sessionId: 'session-1',
          text: 'Hello',
          timestamp: DateTime.now(),
          direction: MessageDirection.outgoing,
          status: MessageStatus.failed,
        );

        expect(message.isSent, false);
      });
    });

    group('copyWith', () {
      test('creates copy with updated status', () {
        final original = ChatMessage.outgoing(
          sessionId: 'session-1',
          text: 'Hello',
        );

        final updated = original.copyWith(status: MessageStatus.sent);

        expect(updated.id, original.id);
        expect(updated.text, original.text);
        expect(updated.status, MessageStatus.sent);
      });

      test('creates copy with eventId', () {
        final original = ChatMessage.outgoing(
          sessionId: 'session-1',
          text: 'Hello',
        );

        final updated = original.copyWith(eventId: 'new-event-id');

        expect(updated.eventId, 'new-event-id');
        expect(updated.text, original.text);
      });
    });
  });

  group('MessageDirection', () {
    test('has incoming and outgoing values', () {
      expect(MessageDirection.values, contains(MessageDirection.incoming));
      expect(MessageDirection.values, contains(MessageDirection.outgoing));
    });
  });

  group('MessageStatus', () {
    test('has all expected values', () {
      expect(MessageStatus.values, contains(MessageStatus.pending));
      expect(MessageStatus.values, contains(MessageStatus.queued));
      expect(MessageStatus.values, contains(MessageStatus.sent));
      expect(MessageStatus.values, contains(MessageStatus.delivered));
      expect(MessageStatus.values, contains(MessageStatus.seen));
      expect(MessageStatus.values, contains(MessageStatus.failed));
    });
  });
}

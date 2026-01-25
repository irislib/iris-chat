import 'package:flutter_test/flutter_test.dart';

import 'package:iris_chat/core/services/nostr_service.dart';

void main() {
  group('NostrService', () {
    group('NostrEvent', () {
      test('fromJson parses valid event', () {
        final json = {
          'id': 'abc123',
          'pubkey': 'pub123',
          'created_at': 1700000000,
          'kind': 1,
          'tags': [
            ['p', 'recipient123'],
            ['e', 'event123'],
          ],
          'content': 'Hello world',
          'sig': 'sig123',
        };

        final event = NostrEvent.fromJson(json);

        expect(event.id, 'abc123');
        expect(event.pubkey, 'pub123');
        expect(event.createdAt, 1700000000);
        expect(event.kind, 1);
        expect(event.content, 'Hello world');
        expect(event.sig, 'sig123');
        expect(event.subscriptionId, isNull);
      });

      test('fromJson with subscriptionId', () {
        final json = {
          'id': 'abc123',
          'pubkey': 'pub123',
          'created_at': 1700000000,
          'kind': 1,
          'tags': <List<String>>[],
          'content': 'Hello',
          'sig': 'sig123',
        };

        final event = NostrEvent.fromJson(json, subscriptionId: 'sub123');

        expect(event.subscriptionId, 'sub123');
      });

      test('getTagValue returns correct value', () {
        const event = NostrEvent(
          id: 'abc',
          pubkey: 'pub',
          createdAt: 0,
          kind: 1,
          tags: [
            ['p', 'recipient123'],
            ['e', 'event123'],
          ],
          content: '',
          sig: '',
        );

        expect(event.getTagValue('p'), 'recipient123');
        expect(event.getTagValue('e'), 'event123');
        expect(event.getTagValue('x'), isNull);
      });

      test('recipientPubkey returns p tag value', () {
        const event = NostrEvent(
          id: 'abc',
          pubkey: 'pub',
          createdAt: 0,
          kind: 1,
          tags: [
            ['p', 'recipient123'],
          ],
          content: '',
          sig: '',
        );

        expect(event.recipientPubkey, 'recipient123');
      });

      test('toJson produces valid map', () {
        const event = NostrEvent(
          id: 'abc',
          pubkey: 'pub',
          createdAt: 1700000000,
          kind: 1,
          tags: [
            ['p', 'recipient'],
          ],
          content: 'Hello',
          sig: 'sig',
        );

        final json = event.toJson();

        expect(json['id'], 'abc');
        expect(json['pubkey'], 'pub');
        expect(json['created_at'], 1700000000);
        expect(json['kind'], 1);
        expect(json['content'], 'Hello');
        expect(json['sig'], 'sig');
        // subscriptionId should not be in JSON output
        expect(json.containsKey('subscriptionId'), false);
      });
    });

    group('NostrFilter', () {
      test('toJson includes only non-null fields', () {
        const filter = NostrFilter(
          authors: ['author1', 'author2'],
          kinds: [1, 4],
          since: 1700000000,
        );

        final json = filter.toJson();

        expect(json['authors'], ['author1', 'author2']);
        expect(json['kinds'], [1, 4]);
        expect(json['since'], 1700000000);
        expect(json.containsKey('ids'), false);
        expect(json.containsKey('until'), false);
        expect(json.containsKey('limit'), false);
      });

      test('toJson includes p tags correctly', () {
        const filter = NostrFilter(
          pTags: ['pubkey1', 'pubkey2'],
          kinds: [443],
        );

        final json = filter.toJson();

        expect(json['#p'], ['pubkey1', 'pubkey2']);
        expect(json['kinds'], [443]);
      });

      test('toJson includes e tags correctly', () {
        const filter = NostrFilter(
          eTags: ['event1'],
          limit: 10,
        );

        final json = filter.toJson();

        expect(json['#e'], ['event1']);
        expect(json['limit'], 10);
      });
    });

    group('NostrService instance', () {
      test('creates with default relays', () {
        final service = NostrService();

        expect(service.connectedCount, 0); // Not connected yet
        expect(service.isDisposed, false);
      });

      test('creates with custom relays', () {
        final service = NostrService(relayUrls: ['wss://custom.relay']);

        expect(service.connectedCount, 0);
        expect(service.isDisposed, false);
      });

      test('connectionStatus returns map of relay statuses', () {
        final service = NostrService(
          relayUrls: ['wss://relay1.com', 'wss://relay2.com'],
        );

        final status = service.connectionStatus;

        expect(status.length, 2);
        expect(status.containsKey('wss://relay1.com'), true);
        expect(status.containsKey('wss://relay2.com'), true);
        // Not connected initially
        expect(status['wss://relay1.com'], false);
        expect(status['wss://relay2.com'], false);
      });

      test('dispose sets isDisposed to true', () async {
        final service = NostrService(relayUrls: ['wss://relay.test']);

        expect(service.isDisposed, false);
        await service.dispose();
        expect(service.isDisposed, true);
      });

      test('dispose is idempotent', () async {
        final service = NostrService(relayUrls: ['wss://relay.test']);

        await service.dispose();
        await service.dispose(); // Should not throw
        expect(service.isDisposed, true);
      });

      test('connect throws after dispose', () async {
        final service = NostrService(relayUrls: ['wss://relay.test']);
        await service.dispose();

        expect(service.connect, throwsStateError);
      });

      test('subscribe throws after dispose', () async {
        final service = NostrService(relayUrls: ['wss://relay.test']);
        await service.dispose();

        expect(
          () => service.subscribe(const NostrFilter(kinds: [1])),
          throwsStateError,
        );
      });

      test('publishEvent throws after dispose', () async {
        final service = NostrService(relayUrls: ['wss://relay.test']);
        await service.dispose();

        expect(
          () => service.publishEvent('{}'),
          throwsStateError,
        );
      });
    });

    group('RelayConnectionEvent', () {
      test('creates with required fields', () {
        const event = RelayConnectionEvent(
          url: 'wss://relay.test',
          status: RelayStatus.connected,
        );

        expect(event.url, 'wss://relay.test');
        expect(event.status, RelayStatus.connected);
        expect(event.error, isNull);
      });

      test('creates with error', () {
        const event = RelayConnectionEvent(
          url: 'wss://relay.test',
          status: RelayStatus.error,
          error: 'Connection refused',
        );

        expect(event.status, RelayStatus.error);
        expect(event.error, 'Connection refused');
      });
    });

    group('NostrException', () {
      test('toString includes message', () {
        const exception = NostrException('Test error');

        expect(exception.toString(), 'NostrException: Test error');
        expect(exception.message, 'Test error');
      });
    });
  });
}

import 'package:flutter_test/flutter_test.dart';
import 'package:iris_chat/core/utils/invite_url.dart';

void main() {
  group('invite_url', () {
    group('decodeInviteUrlData', () {
      test('parses JSON fragment', () {
        const url =
            'https://iris.to/#%7B%22purpose%22%3A%22chat%22%2C%22ephemeralKey%22%3A%22eph123%22%2C%22owner%22%3A%22owner_hex%22%7D';
        final data = decodeInviteUrlData(url);
        expect(data, isNotNull);
        expect(data!['purpose'], 'chat');
        expect(data['ephemeralKey'], 'eph123');
        expect(data['owner'], 'owner_hex');
      });

      test('parses invite= JSON fragment', () {
        const url =
            'https://iris.to/#invite=%7B%22purpose%22%3A%22link%22%2C%22ephemeralKey%22%3A%22eph123%22%2C%22owner%22%3A%22owner_hex%22%7D';
        final data = decodeInviteUrlData(url);
        expect(data, isNotNull);
        expect(data!['purpose'], 'link');
        expect(data['ephemeralKey'], 'eph123');
        expect(data['owner'], 'owner_hex');
      });

      test('parses fragment querystring with invite key', () {
        const url =
            'https://iris.to/#foo=bar&invite=%7B%22purpose%22%3A%22chat%22%2C%22owner%22%3A%22owner_hex%22%7D';
        final data = decodeInviteUrlData(url);
        expect(data, isNotNull);
        expect(data!['purpose'], 'chat');
        expect(data['owner'], 'owner_hex');
      });

      test('unwraps {"invite": {...}} wrapper', () {
        const url =
            'https://iris.to/#%7B%22invite%22%3A%7B%22purpose%22%3A%22chat%22%2C%22owner%22%3A%22owner_hex%22%7D%7D';
        final data = decodeInviteUrlData(url);
        expect(data, isNotNull);
        expect(data!['purpose'], 'chat');
        expect(data['owner'], 'owner_hex');
        expect(data.containsKey('invite'), isFalse);
      });

      test('parses ?invite= query param', () {
        const url =
            'https://iris.to/invite?invite=%7B%22purpose%22%3A%22chat%22%2C%22owner%22%3A%22owner_hex%22%7D';
        final data = decodeInviteUrlData(url);
        expect(data, isNotNull);
        expect(data!['purpose'], 'chat');
        expect(data['owner'], 'owner_hex');
      });
    });

    group('extractors', () {
      test('extractInvitePurpose reads purpose from decoded data', () {
        const url =
            'https://iris.to/#invite=%7B%22purpose%22%3A%22link%22%7D';
        expect(extractInvitePurpose(url), 'link');
      });

      test('extractInviteOwnerPubkeyHex reads owner from decoded data', () {
        const url =
            'https://iris.to/#invite=%7B%22purpose%22%3A%22chat%22%2C%22owner%22%3A%22owner_hex%22%7D';
        expect(extractInviteOwnerPubkeyHex(url), 'owner_hex');
      });

      test('extractInviteOwnerPubkeyHex reads ownerPubkey alias', () {
        const url =
            'https://iris.to/#invite=%7B%22purpose%22%3A%22chat%22%2C%22ownerPubkey%22%3A%22owner_hex%22%7D';
        expect(extractInviteOwnerPubkeyHex(url), 'owner_hex');
      });
    });
  });
}

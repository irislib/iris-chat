import 'package:flutter_test/flutter_test.dart';
import 'package:iris_chat/core/utils/invite_url.dart';
import 'package:nostr/nostr.dart' as nostr;

void main() {
  group('invite_url', () {
    const pubkeyHex =
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    final npub = nostr.Nip19.encodePubkey(pubkeyHex) as String;

    group('looksLikeInviteUrl', () {
      test('accepts JSON fragment invites', () {
        const url =
            'https://iris.to/#%7B%22purpose%22%3A%22chat%22%2C%22ephemeralKey%22%3A%22eph123%22%2C%22owner%22%3A%22owner_hex%22%7D';
        expect(looksLikeInviteUrl(url), isTrue);
      });

      test('accepts invite= fragment invites', () {
        const url =
            'https://iris.to/#invite=%7B%22purpose%22%3A%22chat%22%2C%22owner%22%3A%22owner_hex%22%7D';
        expect(looksLikeInviteUrl(url), isTrue);
      });

      test('accepts legacy /invite?id=...&secret=... format', () {
        const url = 'https://iris.to/invite?id=abc&secret=def';
        expect(looksLikeInviteUrl(url), isTrue);
      });

      test('rejects chat.iris.to npub profile links', () {
        final url = 'https://chat.iris.to/#$npub';
        expect(looksLikeInviteUrl(url), isFalse);
      });
    });

    group('looksLikeNostrIdentityLink', () {
      test('detects npub in URL fragment', () {
        final url = 'https://chat.iris.to/#$npub';
        expect(looksLikeNostrIdentityLink(url), isTrue);
      });

      test('detects bare npub', () {
        expect(looksLikeNostrIdentityLink(npub), isTrue);
      });

      test('detects nostr:npub scheme', () {
        final url = 'nostr:$npub';
        expect(looksLikeNostrIdentityLink(url), isTrue);
      });
    });

    group('extractNostrIdentityPubkeyHex', () {
      test('extracts pubkey hex from bare npub', () {
        expect(extractNostrIdentityPubkeyHex(npub), pubkeyHex);
      });

      test('extracts pubkey hex from nostr:npub scheme', () {
        expect(extractNostrIdentityPubkeyHex('nostr:$npub'), pubkeyHex);
      });

      test('extracts pubkey hex from URL fragment', () {
        expect(
          extractNostrIdentityPubkeyHex('https://chat.iris.to/#$npub'),
          pubkeyHex,
        );
      });

      test('extracts pubkey hex from URL fragment with hash-routing slash', () {
        expect(
          extractNostrIdentityPubkeyHex('https://chat.iris.to/#/$npub'),
          pubkeyHex,
        );
      });

      test('extracts pubkey hex from nprofile', () {
        // NIP-19 nprofile encodes a TLV where type=0 is the 32-byte pubkey.
        const tlvHex = '0020$pubkeyHex';
        final nprofile = nostr.bech32Encode('nprofile', tlvHex);
        expect(extractNostrIdentityPubkeyHex(nprofile), pubkeyHex);
      });
    });

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
        const url = 'https://iris.to/#invite=%7B%22purpose%22%3A%22link%22%7D';
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

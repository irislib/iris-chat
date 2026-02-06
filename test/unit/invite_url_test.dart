import 'package:flutter_test/flutter_test.dart';
import 'package:iris_chat/core/utils/invite_url.dart';

void main() {
  group('invite_url', () {
    test('extractInvitePurpose returns null for urls without fragments', () {
      expect(extractInvitePurpose('https://iris.to/invite'), isNull);
    });

    test('extractInvitePurpose returns purpose from fragment json', () {
      final url = Uri.parse('https://iris.to').replace(
        fragment: Uri.encodeComponent('{"purpose":"link"}'),
      );
      expect(extractInvitePurpose(url.toString()), 'link');
    });

    test('extractInviteOwnerPubkeyHex returns owner from fragment json', () {
      final url = Uri.parse('https://iris.to').replace(
        fragment: Uri.encodeComponent(
          '{"purpose":"chat","owner":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
        ),
      );
      expect(
        extractInviteOwnerPubkeyHex(url.toString()),
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      );
    });

    test('extractInviteOwnerPubkeyHex supports legacy ownerPubkey key', () {
      final url = Uri.parse('https://iris.to').replace(
        fragment: Uri.encodeComponent(
          '{"ownerPubkey":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}',
        ),
      );
      expect(
        extractInviteOwnerPubkeyHex(url.toString()),
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      );
    });
  });
}


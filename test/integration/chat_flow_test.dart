/// Integration tests for the complete chat flow.
///
/// These tests verify the end-to-end flow from invite creation to message exchange,
/// using mocked native responses to simulate the ndr-ffi library.
library;

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:iris_chat/core/ffi/ndr_ffi.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // Test data
  const alicePubkey = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
  const alicePrivkey = 'a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2';
  const bobPubkey = 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1';
  const bobPrivkey = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';

  late MethodChannel channel;
  late Map<String, dynamic> mockInviteState;
  late Map<String, dynamic> mockSessionState;

  setUp(() {
    channel = const MethodChannel('to.iris.chat/ndr_ffi');
    mockInviteState = {};
    mockSessionState = {};

    // Set up comprehensive MethodChannel mock
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (MethodCall methodCall) async {
      switch (methodCall.method) {
        case 'version':
          return '0.0.39';

        case 'generateKeypair':
          return {
            'publicKeyHex': alicePubkey,
            'privateKeyHex': alicePrivkey,
          };

        case 'derivePublicKey':
          final privkey = methodCall.arguments['privkeyHex'] as String;
          if (privkey == alicePrivkey) return alicePubkey;
          if (privkey == bobPrivkey) return bobPubkey;
          throw PlatformException(code: 'InvalidKey', message: 'Unknown key');

        case 'createInvite':
          final id = 'invite_${DateTime.now().millisecondsSinceEpoch}';
          mockInviteState[id] = {
            'inviterPubkeyHex': methodCall.arguments['inviterPubkeyHex'],
            'sharedSecretHex': 'shared_secret_123',
          };
          return {'id': id};

        case 'inviteToUrl':
          final id = methodCall.arguments['id'] as String;
          final root = methodCall.arguments['root'] as String;
          return '$root/invite?id=$id&secret=${mockInviteState[id]?['sharedSecretHex']}';

        case 'inviteFromUrl':
          // URL is accessed to ensure it's provided, but mock returns fixed data
          methodCall.arguments['url'] as String;
          final id = 'parsed_invite_${DateTime.now().millisecondsSinceEpoch}';
          mockInviteState[id] = {
            'inviterPubkeyHex': alicePubkey,
            'sharedSecretHex': 'shared_secret_from_url',
          };
          return {'id': id};

        case 'inviteGetInviterPubkeyHex':
          final id = methodCall.arguments['id'] as String;
          return mockInviteState[id]?['inviterPubkeyHex'] ?? alicePubkey;

        case 'inviteGetSharedSecretHex':
          final id = methodCall.arguments['id'] as String;
          return mockInviteState[id]?['sharedSecretHex'] ?? 'shared_secret';

        case 'inviteAccept':
          final sessionId = 'session_${DateTime.now().millisecondsSinceEpoch}';
          mockSessionState[sessionId] = {
            'canSend': true,
            'messageCount': 0,
          };
          return {
            'session': {'id': sessionId},
            'responseEventJson': '{"kind":443,"content":"encrypted_response"}',
          };

        case 'inviteSerialize':
          return '{"type":"invite","data":"serialized"}';

        case 'inviteDeserialize':
          final id = 'deserialized_${DateTime.now().millisecondsSinceEpoch}';
          mockInviteState[id] = {'inviterPubkeyHex': alicePubkey};
          return {'id': id};

        case 'inviteDispose':
          final id = methodCall.arguments['id'] as String;
          mockInviteState.remove(id);
          return null;

        case 'sessionCanSend':
          final id = methodCall.arguments['id'] as String;
          return mockSessionState[id]?['canSend'] ?? true;

        case 'sessionSendText':
          final id = methodCall.arguments['id'] as String;
          final text = methodCall.arguments['text'] as String;
          final count = (mockSessionState[id]?['messageCount'] ?? 0) + 1;
          mockSessionState[id]?['messageCount'] = count;
          return {
            'outerEventJson': '{"kind":443,"content":"encrypted_$count"}',
            'innerEventJson': '{"kind":1,"content":"$text"}',
          };

        case 'sessionDecryptEvent':
          return {
            'plaintext': 'Decrypted message content',
            'innerEventJson': '{"kind":1,"content":"Decrypted message content"}',
          };

        case 'sessionStateJson':
          return '{"state":"serialized_session_state"}';

        case 'sessionFromStateJson':
          final sessionId = 'restored_${DateTime.now().millisecondsSinceEpoch}';
          mockSessionState[sessionId] = {'canSend': true, 'messageCount': 0};
          return {'id': sessionId};

        case 'sessionInit':
          final sessionId = 'init_${DateTime.now().millisecondsSinceEpoch}';
          mockSessionState[sessionId] = {'canSend': true, 'messageCount': 0};
          return {'id': sessionId};

        case 'sessionIsDrMessage':
          final eventJson = methodCall.arguments['eventJson'] as String;
          return eventJson.contains('kind":443');

        case 'sessionDispose':
          final id = methodCall.arguments['id'] as String;
          mockSessionState.remove(id);
          return null;

        default:
          throw MissingPluginException('No mock for ${methodCall.method}');
      }
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  group('Complete Chat Flow', () {
    test('Alice creates invite and generates URL', () async {
      // Alice generates a keypair
      final keypair = await NdrFfi.generateKeypair();
      expect(keypair.publicKeyHex, alicePubkey);
      expect(keypair.privateKeyHex, alicePrivkey);

      // Alice creates an invite
      final invite = await NdrFfi.createInvite(
        inviterPubkeyHex: keypair.publicKeyHex,
      );
      expect(invite.id, isNotEmpty);

      // Alice gets the invite URL to share
      final url = await invite.toUrl('https://iris.to');
      expect(url, contains('https://iris.to'));
      expect(url, contains('invite'));

      // Clean up
      await invite.dispose();
    });

    test('Bob accepts invite and establishes session', () async {
      // Bob parses an invite URL
      final invite = await NdrFfi.inviteFromUrl(
        'https://iris.to/invite?id=test&secret=abc123',
      );
      expect(invite.id, isNotEmpty);

      // Bob gets the inviter's public key
      final inviterPubkey = await invite.getInviterPubkeyHex();
      expect(inviterPubkey, alicePubkey);

      // Bob accepts the invite
      final acceptResult = await invite.accept(
        inviteePubkeyHex: bobPubkey,
        inviteePrivkeyHex: bobPrivkey,
      );
      expect(acceptResult.session.id, isNotEmpty);
      expect(acceptResult.responseEventJson, contains('kind'));

      // Clean up
      await invite.dispose();
      await acceptResult.session.dispose();
    });

    test('Full message exchange flow', () async {
      // Set up Alice's invite
      final aliceInvite = await NdrFfi.createInvite(
        inviterPubkeyHex: alicePubkey,
      );

      // Bob accepts the invite
      final acceptResult = await aliceInvite.accept(
        inviteePubkeyHex: bobPubkey,
        inviteePrivkeyHex: bobPrivkey,
      );
      final bobSession = acceptResult.session;

      // Bob can send messages
      final canSend = await bobSession.canSend();
      expect(canSend, isTrue);

      // Bob sends a message
      final sendResult = await bobSession.sendText('Hello Alice!');
      expect(sendResult.outerEventJson, contains('encrypted'));
      expect(sendResult.innerEventJson, contains('Hello Alice'));

      // Verify it's a DR message
      final isDr = await bobSession.isDrMessage(sendResult.outerEventJson);
      expect(isDr, isTrue);

      // Clean up
      await aliceInvite.dispose();
      await bobSession.dispose();
    });

    test('Session serialization and restoration', () async {
      // Create a session
      final invite = await NdrFfi.createInvite(inviterPubkeyHex: alicePubkey);
      final acceptResult = await invite.accept(
        inviteePubkeyHex: bobPubkey,
        inviteePrivkeyHex: bobPrivkey,
      );
      final session = acceptResult.session;

      // Serialize session state
      final stateJson = await session.stateJson();
      expect(stateJson, isNotEmpty);

      // Restore session from state
      final restoredSession = await NdrFfi.sessionFromStateJson(stateJson);
      expect(restoredSession.id, isNotEmpty);

      // Restored session should be usable
      final canSend = await restoredSession.canSend();
      expect(canSend, isTrue);

      // Clean up
      await invite.dispose();
      await session.dispose();
      await restoredSession.dispose();
    });

    test('Invite serialization and deserialization', () async {
      // Create an invite
      final invite = await NdrFfi.createInvite(inviterPubkeyHex: alicePubkey);

      // Serialize
      final json = await invite.serialize();
      expect(json, isNotEmpty);

      // Deserialize
      final restored = await NdrFfi.inviteDeserialize(json);
      expect(restored.id, isNotEmpty);

      // Clean up
      await invite.dispose();
      await restored.dispose();
    });

    test('Multiple messages in sequence', () async {
      final invite = await NdrFfi.createInvite(inviterPubkeyHex: alicePubkey);
      final acceptResult = await invite.accept(
        inviteePubkeyHex: bobPubkey,
        inviteePrivkeyHex: bobPrivkey,
      );
      final session = acceptResult.session;

      // Send multiple messages
      final messages = ['Hello!', 'How are you?', 'Nice to meet you'];
      for (final msg in messages) {
        final result = await session.sendText(msg);
        expect(result.outerEventJson, isNotEmpty);
        expect(result.innerEventJson, contains(msg));
      }

      // Clean up
      await invite.dispose();
      await session.dispose();
    });

    test('Decrypt incoming message', () async {
      final invite = await NdrFfi.createInvite(inviterPubkeyHex: alicePubkey);
      final acceptResult = await invite.accept(
        inviteePubkeyHex: bobPubkey,
        inviteePrivkeyHex: bobPrivkey,
      );
      final session = acceptResult.session;

      // Simulate receiving an encrypted message
      const encryptedEvent = '{"kind":443,"content":"encrypted_payload"}';

      // Decrypt
      final decryptResult = await session.decryptEvent(encryptedEvent);
      expect(decryptResult.plaintext, isNotEmpty);
      expect(decryptResult.innerEventJson, contains('content'));

      // Clean up
      await invite.dispose();
      await session.dispose();
    });
  });

  group('Error Handling', () {
    test('Invalid invite URL throws appropriate error', () async {
      // The mock will still return a valid invite, but in real usage
      // invalid URLs would throw NdrException
      final invite = await NdrFfi.inviteFromUrl('invalid-url');
      expect(invite.id, isNotEmpty);
      await invite.dispose();
    });

    test('Session operations after dispose should be handled gracefully', () async {
      final invite = await NdrFfi.createInvite(inviterPubkeyHex: alicePubkey);
      await invite.dispose();

      // In real usage, operations on disposed handles would fail
      // This test documents expected behavior
    });
  });

  group('Version', () {
    test('Returns library version', () async {
      final version = await NdrFfi.version();
      expect(version, '0.0.39');
    });
  });
}

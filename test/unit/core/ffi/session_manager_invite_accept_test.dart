import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:iris_chat/core/ffi/ndr_ffi.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('to.iris.chat/ndr_ffi');

  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          switch (call.method) {
            case 'sessionManagerNew':
              return {'id': 'mgr-1'};
            case 'sessionManagerAcceptInviteFromUrl':
              return {
                'ownerPubkeyHex':
                    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                'inviterDevicePubkeyHex':
                    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                'deviceId': 'device-b',
                'createdNewSession': true,
              };
            case 'sessionManagerAcceptInviteFromEventJson':
              return {
                'ownerPubkeyHex':
                    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
                'inviterDevicePubkeyHex':
                    'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
                'deviceId': 'device-d',
                'createdNewSession': false,
              };
            default:
              throw MissingPluginException('No mock for ${call.method}');
          }
        });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test('session manager can accept invite from URL', () async {
    final manager = await NdrFfi.createSessionManager(
      ourPubkeyHex:
          '1111111111111111111111111111111111111111111111111111111111111111',
      ourIdentityPrivkeyHex:
          '2222222222222222222222222222222222222222222222222222222222222222',
      deviceId: 'device-a',
    );

    final result = await manager.acceptInviteFromUrl(
      inviteUrl: 'https://iris.to/#invite',
    );

    expect(
      result.ownerPubkeyHex,
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(
      result.inviterDevicePubkeyHex,
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    expect(result.deviceId, 'device-b');
    expect(result.createdNewSession, isTrue);
  });

  test('session manager can accept invite from event JSON', () async {
    final manager = await NdrFfi.createSessionManager(
      ourPubkeyHex:
          '3333333333333333333333333333333333333333333333333333333333333333',
      ourIdentityPrivkeyHex:
          '4444444444444444444444444444444444444444444444444444444444444444',
      deviceId: 'device-c',
    );

    final result = await manager.acceptInviteFromEventJson(
      eventJson: '{"kind":30078,"content":"invite"}',
    );

    expect(
      result.ownerPubkeyHex,
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    );
    expect(
      result.inviterDevicePubkeyHex,
      'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    );
    expect(result.deviceId, 'device-d');
    expect(result.createdNewSession, isFalse);
  });
}

import 'package:flutter_test/flutter_test.dart';

import 'package:iris_chat/features/chat/domain/utils/chat_settings.dart';

void main() {
  group('chat settings', () {
    test('parseChatSettingsContent accepts ttl seconds', () {
      final parsed = parseChatSettingsContent(
        '{"type":"chat-settings","v":1,"messageTtlSeconds":3600}',
      );
      expect(parsed, isNotNull);
      expect(parsed!.messageTtlSeconds, 3600);
    });

    test('parseChatSettingsContent normalizes non-positive ttl to null', () {
      final zero = parseChatSettingsContent(
        '{"type":"chat-settings","v":1,"messageTtlSeconds":0}',
      );
      expect(zero, isNotNull);
      expect(zero!.messageTtlSeconds, isNull);

      final negative = parseChatSettingsContent(
        '{"type":"chat-settings","v":1,"messageTtlSeconds":-5}',
      );
      expect(negative, isNotNull);
      expect(negative!.messageTtlSeconds, isNull);
    });

    test('parseChatSettingsContent accepts null ttl', () {
      final parsed = parseChatSettingsContent(
        '{"type":"chat-settings","v":1,"messageTtlSeconds":null}',
      );
      expect(parsed, isNotNull);
      expect(parsed!.messageTtlSeconds, isNull);
    });

    test('parseChatSettingsContent rejects invalid payloads', () {
      expect(parseChatSettingsContent(''), isNull);
      expect(parseChatSettingsContent('not-json'), isNull);
      expect(
        parseChatSettingsContent('{"type":"chat-settings","v":2}'),
        isNull,
      );
      expect(parseChatSettingsContent('{"type":"nope","v":1}'), isNull);
      expect(
        parseChatSettingsContent(
          '{"type":"chat-settings","v":1,"messageTtlSeconds":"3600"}',
        ),
        isNull,
      );
    });
  });
}

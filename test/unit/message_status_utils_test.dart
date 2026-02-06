import 'package:flutter_test/flutter_test.dart';

import 'package:iris_chat/features/chat/domain/models/message.dart';
import 'package:iris_chat/features/chat/domain/utils/message_status_utils.dart';

void main() {
  group('shouldAdvanceStatus', () {
    test('advances pending -> sent', () {
      expect(shouldAdvanceStatus(MessageStatus.pending, MessageStatus.sent), isTrue);
    });

    test('advances delivered -> seen', () {
      expect(shouldAdvanceStatus(MessageStatus.delivered, MessageStatus.seen), isTrue);
    });

    test('does not go backwards seen -> delivered', () {
      expect(shouldAdvanceStatus(MessageStatus.seen, MessageStatus.delivered), isFalse);
    });

    test('does not advance when equal', () {
      expect(shouldAdvanceStatus(MessageStatus.delivered, MessageStatus.delivered), isFalse);
    });

    test('allows failed -> delivered (receipt arrived after local failure)', () {
      expect(shouldAdvanceStatus(MessageStatus.failed, MessageStatus.delivered), isTrue);
    });
  });
}


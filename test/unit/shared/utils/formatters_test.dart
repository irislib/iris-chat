import 'package:flutter_test/flutter_test.dart';
import 'package:iris_chat/shared/utils/formatters.dart';

void main() {
  group('formatPubkeyForDisplay', () {
    test('formats long pubkey with ellipsis', () {
      const pubkey =
          'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
      expect(formatPubkeyForDisplay(pubkey), 'a1b2c3...f6a1b2');
    });

    test('returns short pubkey unchanged', () {
      const pubkey = 'short';
      expect(formatPubkeyForDisplay(pubkey), 'short');
    });

    test('returns 12-char pubkey unchanged', () {
      const pubkey = 'exactly12chr';
      expect(formatPubkeyForDisplay(pubkey), 'exactly12chr');
    });

    test('formats 13-char pubkey with ellipsis', () {
      const pubkey = '1234567890123';
      expect(formatPubkeyForDisplay(pubkey), '123456...890123');
    });

    test('handles empty string', () {
      expect(formatPubkeyForDisplay(''), '');
    });
  });

  group('formatDate', () {
    test('formats date correctly', () {
      final date = DateTime(2024, 1, 15, 14, 30);
      expect(formatDate(date), '15/1/2024 14:30');
    });

    test('pads single digit hours and minutes', () {
      final date = DateTime(2024, 3, 5, 9, 5);
      expect(formatDate(date), '5/3/2024 09:05');
    });

    test('handles midnight', () {
      final date = DateTime(2024, 12, 25, 0, 0);
      expect(formatDate(date), '25/12/2024 00:00');
    });
  });

  group('formatTime', () {
    test('formats time correctly', () {
      final time = DateTime(2024, 1, 1, 14, 30);
      expect(formatTime(time), '14:30');
    });

    test('pads single digit hours', () {
      final time = DateTime(2024, 1, 1, 9, 45);
      expect(formatTime(time), '09:45');
    });

    test('pads single digit minutes', () {
      final time = DateTime(2024, 1, 1, 23, 5);
      expect(formatTime(time), '23:05');
    });

    test('handles midnight', () {
      final time = DateTime(2024, 1, 1, 0, 0);
      expect(formatTime(time), '00:00');
    });
  });

  group('formatRelativeDateTime', () {
    test('formats today as time', () {
      final now = DateTime.now();
      final time = DateTime(now.year, now.month, now.day, 14, 30);
      expect(formatRelativeDateTime(time), '14:30');
    });

    test('formats yesterday correctly', () {
      final yesterday = DateTime.now().subtract(const Duration(days: 1));
      expect(formatRelativeDateTime(yesterday), 'Yesterday');
    });

    test('formats days within last week as day names', () {
      // Create a date 3 days ago
      final date = DateTime.now().subtract(const Duration(days: 3));
      final result = formatRelativeDateTime(date);

      // Should be a day name (Mon, Tue, Wed, etc.)
      expect(
        ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        contains(result),
      );
    });

    test('formats older dates as DD/MM', () {
      final date = DateTime.now().subtract(const Duration(days: 10));
      final result = formatRelativeDateTime(date);

      // Should match DD/MM format
      expect(RegExp(r'^\d{1,2}/\d{1,2}$').hasMatch(result), isTrue);
    });
  });
}

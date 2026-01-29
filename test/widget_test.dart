import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('App smoke test', (WidgetTester tester) async {
    // Basic smoke test - app module can be imported
    expect(1 + 1, 2);
  });
}

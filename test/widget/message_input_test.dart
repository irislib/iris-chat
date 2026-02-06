import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:iris_chat/features/chat/presentation/widgets/message_input.dart';

void main() {
  testWidgets('MessageInput: Enter sends, Shift+Enter inserts newline', (tester) async {
    var sendCount = 0;
    final controller = TextEditingController();

    await tester.pumpWidget(
      MaterialApp(
        home: Material(
          child: MessageInput(
            controller: controller,
            onSend: () => sendCount++,
          ),
        ),
      ),
    );

    final field = find.byType(TextField);
    expect(field, findsOneWidget);

    await tester.tap(field);
    await tester.pump();

    await tester.enterText(field, 'hi');
    await tester.pump();

    // Enter sends (no newline).
    await tester.sendKeyDownEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.enter);
    await tester.pump();

    expect(sendCount, 1);
    expect(controller.text, 'hi');

    // Shift+Enter inserts newline, does not send.
    sendCount = 0;
    controller.text = 'hi';
    controller.selection = TextSelection.collapsed(offset: controller.text.length);
    await tester.pump();

    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.pump();

    expect(sendCount, 0);
    expect(controller.text, contains('\n'));
  });
}


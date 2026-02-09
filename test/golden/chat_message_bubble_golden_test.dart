import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:iris_chat/features/chat/domain/models/message.dart';
import 'package:iris_chat/features/chat/presentation/widgets/chat_message_bubble.dart';

void main() {
  ChatMessage buildMessage({required MessageDirection direction}) {
    return ChatMessage(
      id: 'm1',
      sessionId: 's1',
      text: 'hello world',
      timestamp: DateTime(2026, 2, 1, 12, 0, 0),
      direction: direction,
      status: MessageStatus.delivered,
    );
  }

  Widget wrap(Widget child) {
    return MaterialApp(
      home: Scaffold(
        body: Center(
          child: RepaintBoundary(
            key: const Key('golden'),
            child: SizedBox(
              width: 420,
              height: 260,
              child: Padding(
                padding: const EdgeInsets.only(top: 32),
                child: Align(alignment: Alignment.topCenter, child: child),
              ),
            ),
          ),
        ),
      ),
    );
  }

  testWidgets('golden: ChatMessageBubble idle', (tester) async {
    await tester.binding.setSurfaceSize(const Size(600, 260));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(
      wrap(
        ChatMessageBubble(
          message: buildMessage(direction: MessageDirection.incoming),
          onReact: (_) async {},
          onDeleteLocal: () async {},
          onReply: () {},
        ),
      ),
    );
    await tester.pumpAndSettle();

    await expectLater(
      find.byKey(const Key('golden')),
      matchesGoldenFile('goldens/chat_message_bubble_idle.png'),
    );
  });

  testWidgets('golden: ChatMessageBubble hover actions', (tester) async {
    await tester.binding.setSurfaceSize(const Size(600, 260));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(
      wrap(
        ChatMessageBubble(
          message: buildMessage(direction: MessageDirection.incoming),
          onReact: (_) async {},
          onDeleteLocal: () async {},
          onReply: () {},
        ),
      ),
    );
    await tester.pumpAndSettle();

    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    addTearDown(mouse.removePointer);
    await mouse.addPointer();
    await mouse.moveTo(tester.getCenter(find.byType(ChatMessageBubble)));
    await tester.pump();

    await expectLater(
      find.byKey(const Key('golden')),
      matchesGoldenFile('goldens/chat_message_bubble_hover.png'),
    );
  });
}

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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
        body: SizedBox(width: 600, height: 600, child: Center(child: child)),
      ),
    );
  }

  Future<void> longPressBubble(WidgetTester tester) async {
    final center = tester.getCenter(find.byType(ChatMessageBubble));
    final gesture = await tester.startGesture(center);
    await tester.pump(const Duration(milliseconds: 700));
    await gesture.up();
  }

  testWidgets('ChatMessageBubble: hover shows action dock', (tester) async {
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

    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    addTearDown(mouse.removePointer);
    await mouse.addPointer();
    await mouse.moveTo(Offset.zero);
    await tester.pump();

    expect(find.byKey(const Key('chat_message_action_reply')), findsNothing);
    expect(find.byKey(const Key('chat_message_action_react')), findsNothing);
    expect(find.byKey(const Key('chat_message_action_more')), findsNothing);

    await mouse.moveTo(tester.getCenter(find.byType(ChatMessageBubble)));
    await tester.pump();

    expect(find.byKey(const Key('chat_message_action_reply')), findsOneWidget);
    expect(find.byKey(const Key('chat_message_action_react')), findsOneWidget);
    expect(find.byKey(const Key('chat_message_action_more')), findsOneWidget);

    await mouse.moveTo(Offset.zero);
    await tester.pump();

    expect(find.byKey(const Key('chat_message_action_reply')), findsNothing);
  });

  testWidgets(
    'ChatMessageBubble: long press shows emoji picker and context menu',
    (tester) async {
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

      await longPressBubble(tester);
      await tester.pumpAndSettle();

      expect(find.text('❤️'), findsOneWidget);
      expect(find.text('Copy'), findsOneWidget);
      expect(find.text('Delete locally'), findsOneWidget);
    },
  );

  testWidgets('ChatMessageBubble: Copy copies message text', (tester) async {
    String? copiedText;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'Clipboard.setData') {
            final args = call.arguments as Map<dynamic, dynamic>?;
            copiedText = args?['text']?.toString();
            return null;
          }
          return null;
        });
    addTearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null);
    });

    await tester.pumpWidget(
      wrap(
        ChatMessageBubble(
          message: buildMessage(direction: MessageDirection.incoming),
          onReact: (_) async {},
          onDeleteLocal: () async {},
        ),
      ),
    );

    await longPressBubble(tester);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Copy'));
    await tester.pump(const Duration(milliseconds: 200));

    expect(copiedText, 'hello world');
  });

  testWidgets('ChatMessageBubble: Delete locally calls callback', (
    tester,
  ) async {
    var deleteCount = 0;
    await tester.pumpWidget(
      wrap(
        ChatMessageBubble(
          message: buildMessage(direction: MessageDirection.incoming),
          onReact: (_) async {},
          onDeleteLocal: () async {
            deleteCount++;
          },
        ),
      ),
    );

    await longPressBubble(tester);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete locally'));
    await tester.pump(const Duration(milliseconds: 900));

    expect(deleteCount, 1);
  });
}

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Chat composer input.
///
/// Desktop behavior:
/// - `Enter` sends
/// - `Shift/Ctrl/Alt/Meta + Enter` inserts a newline
class MessageInput extends StatefulWidget {
  const MessageInput({
    super.key,
    required this.controller,
    required this.onSend,
    this.onChanged,
    this.autofocus = false,
  });

  final TextEditingController controller;
  final VoidCallback onSend;
  final ValueChanged<String>? onChanged;
  final bool autofocus;

  @override
  State<MessageInput> createState() => _MessageInputState();
}

class _MessageInputState extends State<MessageInput> {
  late final FocusNode _focusNode;

  static const _inputBorderRadius = BorderRadius.all(Radius.circular(24));
  static const _contentPadding = EdgeInsets.symmetric(horizontal: 16, vertical: 10);
  static const _spacing = SizedBox(width: 8);
  static const _sendIcon = Icon(Icons.send);

  @override
  void initState() {
    super.initState();
    _focusNode = FocusNode(onKeyEvent: _handleKeyEvent);
  }

  @override
  void dispose() {
    _focusNode.dispose();
    super.dispose();
  }

  KeyEventResult _handleKeyEvent(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;

    final key = event.logicalKey;
    final isEnter =
        key == LogicalKeyboardKey.enter || key == LogicalKeyboardKey.numpadEnter;
    if (!isEnter) return KeyEventResult.ignored;

    final hk = HardwareKeyboard.instance;
    final hasModifier =
        hk.isShiftPressed || hk.isControlPressed || hk.isAltPressed || hk.isMetaPressed;
    if (hasModifier) {
      _insertNewline();
      return KeyEventResult.handled;
    }

    widget.onSend();
    return KeyEventResult.handled;
  }

  void _insertNewline() {
    final value = widget.controller.value;
    final selection = value.selection;
    final text = value.text;

    if (!selection.isValid) {
      final next = '$text\n';
      widget.controller.value = value.copyWith(
        text: next,
        selection: TextSelection.collapsed(offset: next.length),
        composing: TextRange.empty,
      );
      return;
    }

    final start = selection.start;
    final end = selection.end;
    final nextText = text.replaceRange(start, end, '\n');
    widget.controller.value = value.copyWith(
      text: nextText,
      selection: TextSelection.collapsed(offset: start + 1),
      composing: TextRange.empty,
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Container(
      padding: EdgeInsets.only(
        left: 16,
        right: 8,
        top: 8,
        bottom: MediaQuery.paddingOf(context).bottom + 8,
      ),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        border: Border(
          top: BorderSide(color: theme.colorScheme.outlineVariant),
        ),
      ),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              focusNode: _focusNode,
              controller: widget.controller,
              autofocus: widget.autofocus,
              decoration: InputDecoration(
                hintText: 'Message',
                border: const OutlineInputBorder(
                  borderRadius: _inputBorderRadius,
                  borderSide: BorderSide.none,
                ),
                filled: true,
                fillColor: theme.colorScheme.surfaceContainerHighest,
                contentPadding: _contentPadding,
              ),
              textCapitalization: TextCapitalization.sentences,
              minLines: 1,
              maxLines: 5,
              onChanged: widget.onChanged,
              // For platforms/IME where "submit" exists.
              onSubmitted: (_) => widget.onSend(),
            ),
          ),
          _spacing,
          IconButton.filled(
            onPressed: widget.onSend,
            icon: _sendIcon,
          ),
        ],
      ),
    );
  }
}

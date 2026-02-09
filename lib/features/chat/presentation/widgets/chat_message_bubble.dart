import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../../shared/utils/formatters.dart';
import '../../domain/models/message.dart';

enum _MessageMenuAction { copy, deleteLocal }

class ChatMessageBubble extends StatefulWidget {
  const ChatMessageBubble({
    super.key,
    required this.message,
    required this.onReact,
    required this.onDeleteLocal,
    this.onReply,
    this.senderLabel,
  });

  final ChatMessage message;

  /// Called when the user selects an emoji to react with.
  final Future<void> Function(String emoji) onReact;

  /// Delete this message from local storage only.
  final Future<void> Function() onDeleteLocal;

  /// Optional "reply" action. (UI-level reply/quote is implemented by the screen.)
  final VoidCallback? onReply;

  /// Optional sender label for group messages (shown only for incoming messages).
  final String? senderLabel;

  @override
  State<ChatMessageBubble> createState() => _ChatMessageBubbleState();
}

class _ChatMessageBubbleState extends State<ChatMessageBubble> {
  bool _showEmojiPicker = false;
  bool _isHovering = false;

  static const _quickEmojis = ['❤️', '👍', '😂', '😮', '😢', '🙏'];
  static const _margin = EdgeInsets.symmetric(vertical: 4);
  static const _padding = EdgeInsets.symmetric(horizontal: 12, vertical: 8);
  static const _outgoingBorderRadius = BorderRadius.only(
    topLeft: Radius.circular(16),
    topRight: Radius.circular(16),
    bottomLeft: Radius.circular(16),
    bottomRight: Radius.circular(4),
  );
  static const _incomingBorderRadius = BorderRadius.only(
    topLeft: Radius.circular(16),
    topRight: Radius.circular(16),
    bottomLeft: Radius.circular(4),
    bottomRight: Radius.circular(16),
  );

  static const _kReplyKey = Key('chat_message_action_reply');
  static const _kReactKey = Key('chat_message_action_react');
  static const _kMoreKey = Key('chat_message_action_more');

  Future<void> _onReact(String emoji) async {
    setState(() => _showEmojiPicker = false);
    await widget.onReact(emoji);
  }

  Future<void> _copyToClipboard() async {
    final text = widget.message.text;
    try {
      await Clipboard.setData(ClipboardData(text: text));
    } catch (_) {
      // Best-effort: Clipboard can be unavailable on some platforms/test environments.
    }
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Copied'), duration: Duration(seconds: 1)),
    );
  }

  Future<void> _deleteLocal() async {
    await widget.onDeleteLocal();
    if (!mounted) return;
    setState(() => _showEmojiPicker = false);
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('Deleted locally'),
        duration: Duration(seconds: 1),
      ),
    );
  }

  RelativeRect _menuPositionFromGlobal(Offset globalPosition) {
    final overlay =
        Overlay.of(context, rootOverlay: true).context.findRenderObject()
            as RenderBox;
    final rect = Rect.fromLTWH(globalPosition.dx, globalPosition.dy, 0, 0);
    return RelativeRect.fromRect(rect, Offset.zero & overlay.size);
  }

  RelativeRect _menuPositionFromBubble() {
    final box = context.findRenderObject() as RenderBox;
    final overlay =
        Overlay.of(context, rootOverlay: true).context.findRenderObject()
            as RenderBox;

    final topLeft = box.localToGlobal(Offset.zero, ancestor: overlay);
    final bottomRight = box.localToGlobal(
      box.size.bottomRight(Offset.zero),
      ancestor: overlay,
    );
    final rect = Rect.fromPoints(topLeft, bottomRight);
    return RelativeRect.fromRect(rect, Offset.zero & overlay.size);
  }

  Future<void> _showContextMenu({Offset? globalPosition}) async {
    final position = globalPosition != null
        ? _menuPositionFromGlobal(globalPosition)
        : _menuPositionFromBubble();

    final action = await showMenu<_MessageMenuAction>(
      context: context,
      position: position,
      items: const [
        PopupMenuItem(value: _MessageMenuAction.copy, child: Text('Copy')),
        PopupMenuItem(
          value: _MessageMenuAction.deleteLocal,
          child: Text('Delete locally'),
        ),
      ],
    );

    switch (action) {
      case _MessageMenuAction.copy:
        await _copyToClipboard();
        break;
      case _MessageMenuAction.deleteLocal:
        await _deleteLocal();
        break;
      case null:
        break;
    }
  }

  Future<void> _showContextMenuSheet() async {
    final theme = Theme.of(context);
    await showModalBottomSheet<void>(
      context: context,
      useSafeArea: true,
      showDragHandle: true,
      builder: (ctx) {
        return Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.copy),
              title: const Text('Copy'),
              onTap: () {
                Navigator.pop(ctx);
                unawaited(_copyToClipboard());
              },
            ),
            ListTile(
              leading: Icon(
                Icons.delete_outline,
                color: theme.colorScheme.error,
              ),
              title: Text(
                'Delete locally',
                style: TextStyle(color: theme.colorScheme.error),
              ),
              onTap: () {
                Navigator.pop(ctx);
                unawaited(_deleteLocal());
              },
            ),
            const SizedBox(height: 8),
          ],
        );
      },
    );
  }

  void _onLongPress() {
    setState(() => _showEmojiPicker = true);
    unawaited(_showContextMenuSheet());
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final message = widget.message;
    final isOutgoing = message.isOutgoing;
    final hasReactions = message.reactions.isNotEmpty;
    final senderLabel =
        (!isOutgoing &&
            widget.senderLabel != null &&
            widget.senderLabel!.trim().isNotEmpty)
        ? widget.senderLabel!.trim()
        : null;

    final actionDock = Material(
      elevation: 2,
      color: theme.colorScheme.surfaceContainerHighest,
      borderRadius: BorderRadius.circular(999),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          IconButton(
            key: _kReplyKey,
            icon: const Icon(Icons.reply, size: 18),
            tooltip: 'Reply',
            visualDensity: VisualDensity.compact,
            onPressed: widget.onReply,
          ),
          IconButton(
            key: _kReactKey,
            icon: const Icon(Icons.emoji_emotions_outlined, size: 18),
            tooltip: 'React',
            visualDensity: VisualDensity.compact,
            onPressed: () => setState(() => _showEmojiPicker = true),
          ),
          IconButton(
            key: _kMoreKey,
            icon: const Icon(Icons.more_horiz, size: 18),
            tooltip: 'More',
            visualDensity: VisualDensity.compact,
            onPressed: _showContextMenu,
          ),
        ],
      ),
    );

    return MouseRegion(
      hitTestBehavior: HitTestBehavior.translucent,
      onEnter: (_) => setState(() => _isHovering = true),
      onExit: (_) => setState(() => _isHovering = false),
      child: GestureDetector(
        behavior: HitTestBehavior.translucent,
        onLongPress: _onLongPress,
        onSecondaryTapDown: (d) =>
            _showContextMenu(globalPosition: d.globalPosition),
        child: Align(
          alignment: isOutgoing ? Alignment.centerRight : Alignment.centerLeft,
          widthFactor: 1.0,
          child: Column(
            crossAxisAlignment: isOutgoing
                ? CrossAxisAlignment.end
                : CrossAxisAlignment.start,
            children: [
              if (senderLabel != null)
                Padding(
                  padding: const EdgeInsets.only(left: 8, right: 8, bottom: 2),
                  child: Text(
                    senderLabel,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
              if (_showEmojiPicker)
                _EmojiPicker(
                  emojis: _quickEmojis,
                  onSelect: _onReact,
                  onDismiss: () => setState(() => _showEmojiPicker = false),
                ),
              Stack(
                clipBehavior: Clip.none,
                children: [
                  Container(
                    margin: _margin.copyWith(bottom: hasReactions ? 0 : 4),
                    constraints: BoxConstraints(
                      maxWidth: MediaQuery.sizeOf(context).width * 0.75,
                    ),
                    padding: _padding,
                    decoration: BoxDecoration(
                      color: isOutgoing
                          ? theme.colorScheme.primaryContainer
                          : theme.colorScheme.surfaceContainerHighest,
                      borderRadius: isOutgoing
                          ? _outgoingBorderRadius
                          : _incomingBorderRadius,
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Text(
                          message.text,
                          style: TextStyle(
                            color: isOutgoing
                                ? theme.colorScheme.onPrimaryContainer
                                : theme.colorScheme.onSurface,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              formatTime(message.timestamp),
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: isOutgoing
                                    ? theme.colorScheme.onPrimaryContainer
                                          .withValues(alpha: 179)
                                    : theme.colorScheme.onSurfaceVariant,
                                fontSize: 11,
                              ),
                            ),
                            if (isOutgoing) ...[
                              const SizedBox(width: 4),
                              _StatusIcon(status: message.status),
                            ],
                          ],
                        ),
                      ],
                    ),
                  ),
                  if (_isHovering)
                    Positioned(
                      top: -6,
                      left: isOutgoing ? -132 : null,
                      right: isOutgoing ? null : -132,
                      child: actionDock,
                    ),
                ],
              ),
              if (hasReactions)
                Align(
                  alignment: Alignment.centerRight,
                  child: Transform.translate(
                    offset: const Offset(0, -8),
                    child: Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: _ReactionsDisplay(reactions: message.reactions),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _EmojiPicker extends StatelessWidget {
  const _EmojiPicker({
    required this.emojis,
    required this.onSelect,
    required this.onDismiss,
  });

  final List<String> emojis;
  final ValueChanged<String> onSelect;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      margin: const EdgeInsets.only(bottom: 4),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(20),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 51),
            blurRadius: 8,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          ...emojis.map(
            (emoji) => GestureDetector(
              onTap: () => onSelect(emoji),
              child: Padding(
                padding: const EdgeInsets.all(4),
                child: Text(emoji, style: const TextStyle(fontSize: 24)),
              ),
            ),
          ),
          GestureDetector(
            onTap: onDismiss,
            child: Padding(
              padding: const EdgeInsets.all(4),
              child: Icon(
                Icons.close,
                size: 20,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ReactionsDisplay extends StatelessWidget {
  const _ReactionsDisplay({required this.reactions});

  final Map<String, List<String>> reactions;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Wrap(
      alignment: WrapAlignment.end,
      spacing: 4,
      children: reactions.entries.map((entry) {
        final emoji = entry.key;
        final count = entry.value.length;
        return Container(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
          decoration: BoxDecoration(
            color: theme.colorScheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: theme.colorScheme.onSurface.withValues(alpha: 0.15),
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(emoji, style: const TextStyle(fontSize: 14)),
              if (count > 1) ...[
                const SizedBox(width: 2),
                Text(
                  count.toString(),
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ],
          ),
        );
      }).toList(),
    );
  }
}

class _StatusIcon extends StatelessWidget {
  const _StatusIcon({required this.status});

  final MessageStatus status;

  static const _queuedIcon = Icon(
    Icons.cloud_queue,
    size: 14,
    color: Colors.orange,
  );
  static const _iconSize = 14.0;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final baseColor = theme.colorScheme.onPrimaryContainer.withValues(
      alpha: 179,
    );

    switch (status) {
      case MessageStatus.pending:
        return Icon(Icons.schedule, size: _iconSize, color: baseColor);
      case MessageStatus.queued:
        return _queuedIcon;
      case MessageStatus.sent:
        return Icon(Icons.check, size: _iconSize, color: baseColor);
      case MessageStatus.delivered:
        return Icon(Icons.done_all, size: _iconSize, color: baseColor);
      case MessageStatus.seen:
        return const Icon(Icons.done_all, size: _iconSize, color: Colors.blue);
      case MessageStatus.failed:
        return Icon(
          Icons.error_outline,
          size: _iconSize,
          color: theme.colorScheme.error,
        );
    }
  }
}

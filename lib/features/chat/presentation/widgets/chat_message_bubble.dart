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
  bool _isHovering = false;

  static const _quickEmojis = ['❤️', '👍', '😂', '😮', '😢', '🙏'];
  static const _dockSlotWidth = 132.0;
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
  static const _kRowKey = Key('chat_message_row');

  Future<void> _onReact(String emoji) async {
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

  bool get _useSheetForMenu {
    switch (Theme.of(context).platform) {
      case TargetPlatform.android:
      case TargetPlatform.iOS:
        return true;
      case TargetPlatform.fuchsia:
      case TargetPlatform.linux:
      case TargetPlatform.macOS:
      case TargetPlatform.windows:
        return false;
    }
  }

  Future<void> _showActionsMenu({Offset? globalPosition}) async {
    final position = globalPosition != null
        ? _menuPositionFromGlobal(globalPosition)
        : _menuPositionFromBubble();

    final result = await showMenu<Object>(
      context: context,
      position: position,
      items: [
        const _EmojiMenuEntry(emojis: _quickEmojis),
        const PopupMenuDivider(),
        const PopupMenuItem<Object>(
          value: _MessageMenuAction.copy,
          child: Text('Copy'),
        ),
        const PopupMenuItem<Object>(
          value: _MessageMenuAction.deleteLocal,
          child: Text('Delete locally'),
        ),
      ],
    );

    if (result is String) {
      await _onReact(result);
      return;
    }

    switch (result) {
      case _MessageMenuAction.copy:
        await _copyToClipboard();
        break;
      case _MessageMenuAction.deleteLocal:
        await _deleteLocal();
        break;
      default:
        break;
    }
  }

  Future<void> _showActionsSheet() async {
    final theme = Theme.of(context);
    await showModalBottomSheet<void>(
      context: context,
      useSafeArea: true,
      showDragHandle: true,
      builder: (ctx) {
        return Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.only(left: 16, right: 16, top: 4),
              child: Wrap(
                spacing: 8,
                children: _quickEmojis
                    .map(
                      (emoji) => InkResponse(
                        onTap: () {
                          Navigator.pop(ctx);
                          unawaited(_onReact(emoji));
                        },
                        radius: 22,
                        child: Padding(
                          padding: const EdgeInsets.all(6),
                          child: Text(
                            emoji,
                            style: const TextStyle(fontSize: 24),
                          ),
                        ),
                      ),
                    )
                    .toList(),
              ),
            ),
            const SizedBox(height: 8),
            const Divider(height: 1),
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

  void _openActions({Offset? globalPosition}) {
    if (_useSheetForMenu) {
      unawaited(_showActionsSheet());
    } else {
      unawaited(_showActionsMenu(globalPosition: globalPosition));
    }
  }

  void _onLongPress() {
    _openActions();
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
            onPressed: _openActions,
          ),
          IconButton(
            key: _kMoreKey,
            icon: const Icon(Icons.more_horiz, size: 18),
            tooltip: 'More',
            visualDensity: VisualDensity.compact,
            onPressed: _openActions,
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
            _openActions(globalPosition: d.globalPosition),
        child: SizedBox(
          width: double.infinity,
          child: Column(
            mainAxisSize: MainAxisSize.min,
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
              Row(
                key: _kRowKey,
                mainAxisAlignment: isOutgoing
                    ? MainAxisAlignment.end
                    : MainAxisAlignment.start,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (isOutgoing)
                    _DockSlot(
                      width: _dockSlotWidth,
                      visible: _isHovering,
                      alignment: Alignment.topRight,
                      child: actionDock,
                    ),
                  Flexible(
                    child: Container(
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
                  ),
                  if (!isOutgoing)
                    _DockSlot(
                      width: _dockSlotWidth,
                      visible: _isHovering,
                      alignment: Alignment.topLeft,
                      child: actionDock,
                    ),
                ],
              ),
              if (hasReactions)
                Row(
                  mainAxisAlignment: isOutgoing
                      ? MainAxisAlignment.end
                      : MainAxisAlignment.start,
                  children: [
                    Transform.translate(
                      offset: const Offset(0, -8),
                      child: Padding(
                        padding: EdgeInsets.only(
                          right: isOutgoing ? 8 : 0,
                          left: isOutgoing ? 0 : 8,
                        ),
                        child: _ReactionsDisplay(
                          reactions: message.reactions,
                          alignment: isOutgoing
                              ? WrapAlignment.end
                              : WrapAlignment.start,
                        ),
                      ),
                    ),
                  ],
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _EmojiMenuEntry extends PopupMenuEntry<Object> {
  const _EmojiMenuEntry({required this.emojis});

  final List<String> emojis;

  @override
  double get height => 48;

  @override
  bool represents(Object? value) => false;

  @override
  State<_EmojiMenuEntry> createState() => _EmojiMenuEntryState();
}

class _EmojiMenuEntryState extends State<_EmojiMenuEntry> {
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final emoji in widget.emojis)
            InkResponse(
              onTap: () => Navigator.pop(context, emoji),
              radius: 22,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                child: Text(emoji, style: const TextStyle(fontSize: 20)),
              ),
            ),
        ],
      ),
    );
  }
}

class _DockSlot extends StatelessWidget {
  const _DockSlot({
    required this.width,
    required this.visible,
    required this.alignment,
    required this.child,
  });

  final double width;
  final bool visible;
  final Alignment alignment;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final targetWidth = visible ? width : 0.0;
    return AnimatedContainer(
      duration: const Duration(milliseconds: 120),
      curve: Curves.easeOut,
      width: targetWidth,
      child: visible
          ? Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Align(alignment: alignment, child: child),
            )
          : null,
    );
  }
}

class _ReactionsDisplay extends StatelessWidget {
  const _ReactionsDisplay({
    required this.reactions,
    this.alignment = WrapAlignment.end,
  });

  final Map<String, List<String>> reactions;
  final WrapAlignment alignment;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Wrap(
      alignment: alignment,
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

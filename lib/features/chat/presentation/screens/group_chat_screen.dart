import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../config/providers/chat_provider.dart';
import '../../../../shared/utils/formatters.dart';
import '../../domain/models/group.dart';
import '../../domain/models/message.dart';
import '../widgets/message_input.dart';

const double _kEstimatedMessageHeight = 80.0;

class GroupChatScreen extends ConsumerStatefulWidget {
  const GroupChatScreen({super.key, required this.groupId});

  final String groupId;

  @override
  ConsumerState<GroupChatScreen> createState() => _GroupChatScreenState();
}

class _GroupChatScreenState extends ConsumerState<GroupChatScreen> {
  final _messageController = TextEditingController();
  final _scrollController = ScrollController();
  bool _isAtBottom = true;

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_onScroll);

    WidgetsBinding.instance.addPostFrameCallback((_) {
      // Best-effort load: navigation can happen before the list screen initializes.
      ref.read(groupStateProvider.notifier).loadGroups();
      ref.read(groupStateProvider.notifier).loadGroupMessages(widget.groupId);
      ref.read(groupStateProvider.notifier).markGroupSeen(widget.groupId);
    });
  }

  @override
  void dispose() {
    _messageController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  void _onScroll() {
    final isAtBottom = _scrollController.position.pixels >=
        _scrollController.position.maxScrollExtent - 50;
    if (isAtBottom != _isAtBottom) {
      setState(() => _isAtBottom = isAtBottom);
    }
  }

  void _scrollToBottom() {
    if (_scrollController.hasClients) {
      _scrollController.animateTo(
        _scrollController.position.maxScrollExtent,
        duration: const Duration(milliseconds: 300),
        curve: Curves.easeOut,
      );
    }
  }

  Future<void> _sendMessage() async {
    final text = _messageController.text.trim();
    if (text.isEmpty) return;

    _messageController.clear();
    WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());

    await ref
        .read(groupStateProvider.notifier)
        .sendGroupMessage(widget.groupId, text);
  }

  @override
  Widget build(BuildContext context) {
    final groups = ref.watch(groupStateProvider.select((s) => s.groups));

    ChatGroup? group;
    for (final g in groups) {
      if (g.id == widget.groupId) {
        group = g;
        break;
      }
    }

    final messages = ref.watch(groupMessagesProvider(widget.groupId));
    final isTyping = ref.watch(
      groupStateProvider.select(
        (s) => s.typingStates[widget.groupId] ?? false,
      ),
    );

    final theme = Theme.of(context);

    if (group == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Group')),
        body: const Center(child: CircularProgressIndicator()),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(group.name),
        actions: [
          IconButton(
            icon: const Icon(Icons.info_outline),
            tooltip: 'Group info',
            onPressed: () => context.push('/groups/${group!.id}/info'),
          ),
          if (!group.accepted)
            Padding(
              padding: const EdgeInsets.only(right: 12),
              child: Center(
                child: Text(
                  'Invite',
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
            ),
        ],
      ),
      body: Column(
        children: [
          if (!group.accepted)
            _InviteBanner(
              onAccept: () async {
                await ref
                    .read(groupStateProvider.notifier)
                    .acceptGroupInvitation(widget.groupId);
              },
            ),
          Expanded(
            child: messages.isEmpty
                ? _buildEmptyMessages(theme)
                : ListView.builder(
                    controller: _scrollController,
                    padding: const EdgeInsets.all(16),
                    itemCount: messages.length,
                    cacheExtent: _kEstimatedMessageHeight * 5,
                    addAutomaticKeepAlives: true,
                    itemBuilder: (context, index) {
                      final message = messages[index];
                      final showDate = index == 0 ||
                          !_isSameDay(
                            messages[index - 1].timestamp,
                            message.timestamp,
                          );

                      return Column(
                        children: [
                          if (showDate) _DateSeparator(date: message.timestamp),
                          _GroupMessageBubble(
                            key: ValueKey(message.id),
                            message: message,
                            groupId: widget.groupId,
                          ),
                        ],
                      );
                    },
                  ),
          ),
          if (!_isAtBottom && messages.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: FloatingActionButton.small(
                onPressed: _scrollToBottom,
                child: const Icon(Icons.arrow_downward),
              ),
            ),
          if (isTyping)
            Padding(
              padding: const EdgeInsets.only(left: 16, right: 16, bottom: 4),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  'Typing…',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
            ),
          if (group.accepted)
            MessageInput(
              controller: _messageController,
              onSend: _sendMessage,
              autofocus: true,
              onChanged: (text) {
                if (text.trim().isEmpty) return;
                ref.read(groupStateProvider.notifier).sendGroupTyping(widget.groupId);
              },
            ),
        ],
      ),
    );
  }

  Widget _buildEmptyMessages(ThemeData theme) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.groups,
              size: 64,
              color: theme.colorScheme.outline,
            ),
            const SizedBox(height: 16),
            Text(
              'Private group chat',
              style: theme.textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            Text(
              'Messages are end-to-end encrypted and fanned out to members.',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }

  bool _isSameDay(DateTime a, DateTime b) {
    return a.year == b.year && a.month == b.month && a.day == b.day;
  }
}

class _InviteBanner extends StatelessWidget {
  const _InviteBanner({required this.onAccept});

  final VoidCallback onAccept;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Material(
      color: theme.colorScheme.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(
          children: [
            Expanded(
              child: Text(
                'Group invitation. Accept to start chatting.',
                style: theme.textTheme.bodyMedium,
              ),
            ),
            FilledButton(
              onPressed: onAccept,
              child: const Text('Accept'),
            ),
          ],
        ),
      ),
    );
  }
}

class _DateSeparator extends StatelessWidget {
  const _DateSeparator({required this.date});

  final DateTime date;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final now = DateTime.now();
    final diff = now.difference(date);

    String text;
    if (diff.inDays == 0) {
      text = 'Today';
    } else if (diff.inDays == 1) {
      text = 'Yesterday';
    } else {
      text = '${date.day}/${date.month}/${date.year}';
    }

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 16),
      child: Center(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
          decoration: BoxDecoration(
            color: theme.colorScheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Text(
            text,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ),
      ),
    );
  }
}

class _GroupMessageBubble extends ConsumerStatefulWidget {
  const _GroupMessageBubble({
    super.key,
    required this.message,
    required this.groupId,
  });

  final ChatMessage message;
  final String groupId;

  @override
  ConsumerState<_GroupMessageBubble> createState() => _GroupMessageBubbleState();
}

class _GroupMessageBubbleState extends ConsumerState<_GroupMessageBubble> {
  bool _showEmojiPicker = false;

  static const _quickEmojis = ['❤️', '👍', '😂', '😮', '😢', '🙏'];

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final message = widget.message;
    final isOutgoing = message.isOutgoing;
    final hasReactions = message.reactions.isNotEmpty;

    final sender = message.senderPubkeyHex;
    final senderLabel = (!isOutgoing && sender != null && sender.isNotEmpty)
        ? _resolveSenderLabel(sender)
        : null;

    return GestureDetector(
      onLongPress: () => setState(() => _showEmojiPicker = true),
      child: Align(
        alignment: isOutgoing ? Alignment.centerRight : Alignment.centerLeft,
        child: Column(
          crossAxisAlignment: isOutgoing ? CrossAxisAlignment.end : CrossAxisAlignment.start,
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
            Container(
              margin: const EdgeInsets.symmetric(vertical: 4).copyWith(bottom: hasReactions ? 0 : 4),
              constraints: BoxConstraints(
                maxWidth: MediaQuery.sizeOf(context).width * 0.75,
              ),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: isOutgoing
                    ? theme.colorScheme.primaryContainer
                    : theme.colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.only(
                  topLeft: const Radius.circular(16),
                  topRight: const Radius.circular(16),
                  bottomLeft: Radius.circular(isOutgoing ? 16 : 4),
                  bottomRight: Radius.circular(isOutgoing ? 4 : 16),
                ),
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
                              ? theme.colorScheme.onPrimaryContainer.withValues(alpha: 179)
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
    );
  }

  String _resolveSenderLabel(String pubkeyHex) {
    final sessions = ref.read(sessionStateProvider).sessions;
    for (final s in sessions) {
      if (s.recipientPubkeyHex == pubkeyHex) return s.displayName;
    }
    return formatPubkeyForDisplay(pubkeyHex);
  }

  Future<void> _onReact(String emoji) async {
    setState(() => _showEmojiPicker = false);

    await ref.read(groupStateProvider.notifier).sendGroupReaction(
          groupId: widget.groupId,
          messageId: widget.message.id,
          emoji: emoji,
        );

    // Local optimistic updates are handled in GroupNotifier.
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

  static const _queuedIcon = Icon(Icons.cloud_queue, size: 14, color: Colors.orange);
  static const _iconSize = 14.0;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final baseColor = theme.colorScheme.onPrimaryContainer.withValues(alpha: 179);

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
        return Icon(Icons.error_outline, size: _iconSize, color: theme.colorScheme.error);
    }
  }
}

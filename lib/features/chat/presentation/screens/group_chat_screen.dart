import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../config/providers/chat_provider.dart';
import '../../../../shared/utils/formatters.dart';
import '../../domain/models/group.dart';
import '../../domain/models/message.dart';
import '../widgets/chat_message_bubble.dart';
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
  final _composerFocusNode = FocusNode();
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
    _composerFocusNode.dispose();
    super.dispose();
  }

  void _onScroll() {
    final isAtBottom =
        _scrollController.position.pixels >=
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

  void _quoteReply(ChatMessage message) {
    final quoted = message.text.split('\n').map((line) => '> $line').join('\n');
    final prefix = '$quoted\n';

    final existing = _messageController.text;
    final nextText = existing.trim().isEmpty ? prefix : '$prefix$existing';
    _messageController.value = TextEditingValue(
      text: nextText,
      selection: TextSelection.collapsed(offset: nextText.length),
    );
    _composerFocusNode.requestFocus();
  }

  String _resolveSenderLabel(String pubkeyHex) {
    final sessions = ref.read(sessionStateProvider).sessions;
    for (final s in sessions) {
      if (s.recipientPubkeyHex == pubkeyHex) return s.displayName;
    }
    return formatPubkeyForDisplay(pubkeyHex);
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
      groupStateProvider.select((s) => s.typingStates[widget.groupId] ?? false),
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
                      final showDate =
                          index == 0 ||
                          !_isSameDay(
                            messages[index - 1].timestamp,
                            message.timestamp,
                          );

                      return Column(
                        children: [
                          if (showDate) _DateSeparator(date: message.timestamp),
                          ChatMessageBubble(
                            key: ValueKey(message.id),
                            message: message,
                            senderLabel:
                                (!message.isOutgoing &&
                                    message.senderPubkeyHex != null &&
                                    message.senderPubkeyHex!.isNotEmpty)
                                ? _resolveSenderLabel(message.senderPubkeyHex!)
                                : null,
                            onReply: () => _quoteReply(message),
                            onReact: (emoji) async {
                              await ref
                                  .read(groupStateProvider.notifier)
                                  .sendGroupReaction(
                                    groupId: widget.groupId,
                                    messageId: message.id,
                                    emoji: emoji,
                                  );
                            },
                            onDeleteLocal: () async {
                              await ref
                                  .read(groupStateProvider.notifier)
                                  .deleteGroupMessageLocal(
                                    widget.groupId,
                                    message.id,
                                  );
                            },
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
              focusNode: _composerFocusNode,
              onChanged: (text) {
                if (text.trim().isEmpty) return;
                ref
                    .read(groupStateProvider.notifier)
                    .sendGroupTyping(widget.groupId);
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
            Icon(Icons.groups, size: 64, color: theme.colorScheme.outline),
            const SizedBox(height: 16),
            Text('Private group chat', style: theme.textTheme.titleMedium),
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
            FilledButton(onPressed: onAccept, child: const Text('Accept')),
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

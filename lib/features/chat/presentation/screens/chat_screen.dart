import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../config/providers/auth_provider.dart';
import '../../../../config/providers/chat_provider.dart';
import '../../../../shared/utils/formatters.dart';
import '../../domain/models/message.dart';
import '../../domain/models/session.dart';

/// Estimated height for a typical message bubble.
/// Used for ListView performance optimization.
const double _kEstimatedMessageHeight = 80.0;

class ChatScreen extends ConsumerStatefulWidget {
  const ChatScreen({super.key, required this.sessionId});

  final String sessionId;

  @override
  ConsumerState<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends ConsumerState<ChatScreen> {
  final _messageController = TextEditingController();
  final _scrollController = ScrollController();
  bool _isAtBottom = true;

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_onScroll);

    // Load messages and clear unread
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(chatStateProvider.notifier).loadMessages(widget.sessionId);
      ref.read(sessionStateProvider.notifier).clearUnread(widget.sessionId);
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

    // Scroll to bottom
    WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());

    // Send message via provider (handles optimistic update, encryption, and Nostr)
    await ref.read(chatStateProvider.notifier).sendMessage(
          widget.sessionId,
          text,
        );

    // Update session metadata
    final messages = ref.read(sessionMessagesProvider(widget.sessionId));
    if (messages.isNotEmpty) {
      await ref.read(sessionStateProvider.notifier).updateSessionWithMessage(
            widget.sessionId,
            messages.last,
          );
    }
  }

  @override
  Widget build(BuildContext context) {
    // Optimized: Use select() to only watch the specific session we need,
    // avoiding rebuilds when other sessions change
    final session = ref.watch(
      sessionStateProvider.select(
        (state) => state.sessions.firstWhere(
          (s) => s.id == widget.sessionId,
          orElse: () => throw Exception('Session not found'),
        ),
      ),
    );
    final messages = ref.watch(sessionMessagesProvider(widget.sessionId));
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(session.displayName),
            Text(
              'Encrypted',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.info_outline),
            onPressed: () => _showSessionInfo(context, session),
          ),
        ],
      ),
      body: Column(
        children: [
          // Messages list
          Expanded(
            child: messages.isEmpty
                ? _buildEmptyMessages(theme)
                : ListView.builder(
                    controller: _scrollController,
                    padding: const EdgeInsets.all(16),
                    itemCount: messages.length,
                    // Performance: Add cacheExtent for smoother scrolling
                    cacheExtent: _kEstimatedMessageHeight * 5,
                    // Performance: addAutomaticKeepAlives helps with message state preservation
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
                          if (showDate)
                            _DateSeparator(date: message.timestamp),
                          _MessageBubble(
                            key: ValueKey(message.id),
                            message: message,
                          ),
                        ],
                      );
                    },
                  ),
          ),

          // Scroll to bottom button
          if (!_isAtBottom && messages.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: FloatingActionButton.small(
                onPressed: _scrollToBottom,
                child: const Icon(Icons.arrow_downward),
              ),
            ),

          // Message input
          _MessageInput(
            controller: _messageController,
            onSend: _sendMessage,
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
              Icons.lock_outline,
              size: 64,
              color: theme.colorScheme.outline,
            ),
            const SizedBox(height: 16),
            Text(
              'End-to-end encrypted',
              style: theme.textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            Text(
              'Messages in this chat are secured with Double Ratchet encryption.',
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

  void _showSessionInfo(BuildContext context, ChatSession session) {
    final theme = Theme.of(context);

    showModalBottomSheet(
      context: context,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  CircleAvatar(
                    radius: 28,
                    backgroundColor: theme.colorScheme.primaryContainer,
                    child: Text(
                      session.displayName.isNotEmpty
                          ? session.displayName[0].toUpperCase()
                          : '?',
                      style: theme.textTheme.headlineSmall?.copyWith(
                        color: theme.colorScheme.onPrimaryContainer,
                      ),
                    ),
                  ),
                  const SizedBox(width: 16),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          session.displayName,
                          style: theme.textTheme.titleLarge,
                        ),
                        const SizedBox(height: 4),
                        Row(
                          children: [
                            Icon(
                              Icons.lock,
                              size: 14,
                              color: theme.colorScheme.primary,
                            ),
                            const SizedBox(width: 4),
                            Text(
                              'End-to-end encrypted',
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: theme.colorScheme.primary,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 24),
              _InfoRow(
                label: 'Public Key',
                value: session.recipientPubkeyHex,
                copyable: true,
              ),
              const SizedBox(height: 12),
              _InfoRow(
                label: 'Session Created',
                value: formatDate(session.createdAt),
              ),
              if (session.inviteId != null) ...[
                const SizedBox(height: 12),
                _InfoRow(
                  label: 'Invite ID',
                  value: session.inviteId!,
                ),
              ],
              const SizedBox(height: 12),
              _InfoRow(
                label: 'Role',
                value: session.isInitiator ? 'Initiator' : 'Responder',
              ),
              const SizedBox(height: 24),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: () => Navigator.pop(context),
                  icon: const Icon(Icons.close),
                  label: const Text('Close'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

}

class _DateSeparator extends StatelessWidget {
  const _DateSeparator({required this.date});

  final DateTime date;

  static const _padding = EdgeInsets.symmetric(vertical: 16);
  static const _containerPadding = EdgeInsets.symmetric(horizontal: 12, vertical: 4);
  static const _borderRadius = BorderRadius.all(Radius.circular(12));

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
      padding: _padding,
      child: Center(
        child: Container(
          padding: _containerPadding,
          decoration: BoxDecoration(
            color: theme.colorScheme.surfaceContainerHighest,
            borderRadius: _borderRadius,
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

class _MessageBubble extends ConsumerStatefulWidget {
  const _MessageBubble({super.key, required this.message});

  final ChatMessage message;

  @override
  ConsumerState<_MessageBubble> createState() => _MessageBubbleState();
}

class _MessageBubbleState extends ConsumerState<_MessageBubble> {
  bool _showEmojiPicker = false;

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

  Future<void> _onReact(String emoji) async {
    setState(() => _showEmojiPicker = false);
    final myPubkey = ref.read(authStateProvider).pubkeyHex ?? 'me';
    await ref.read(chatStateProvider.notifier).sendReaction(
      widget.message.sessionId,
      widget.message.id,
      emoji,
      myPubkey,
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final message = widget.message;
    final isOutgoing = message.isOutgoing;
    final hasReactions = message.reactions.isNotEmpty;

    return GestureDetector(
      onLongPress: () => setState(() => _showEmojiPicker = true),
      child: Align(
        alignment: isOutgoing ? Alignment.centerRight : Alignment.centerLeft,
        child: Column(
          crossAxisAlignment: isOutgoing ? CrossAxisAlignment.end : CrossAxisAlignment.start,
          children: [
            // Emoji picker
            if (_showEmojiPicker)
              _EmojiPicker(
                emojis: _quickEmojis,
                onSelect: _onReact,
                onDismiss: () => setState(() => _showEmojiPicker = false),
                isOutgoing: isOutgoing,
              ),
            // Message bubble
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
                borderRadius: isOutgoing ? _outgoingBorderRadius : _incomingBorderRadius,
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
                              ? theme.colorScheme.onPrimaryContainer.withOpacity(0.7)
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
            // Reactions display
            if (hasReactions)
              Padding(
                padding: EdgeInsets.only(
                  left: isOutgoing ? 0 : 8,
                  right: isOutgoing ? 8 : 0,
                  bottom: 4,
                ),
                child: _ReactionsDisplay(reactions: message.reactions),
              ),
          ],
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
    required this.isOutgoing,
  });

  final List<String> emojis;
  final ValueChanged<String> onSelect;
  final VoidCallback onDismiss;
  final bool isOutgoing;

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
            color: Colors.black.withOpacity(0.2),
            blurRadius: 8,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          ...emojis.map((emoji) => GestureDetector(
            onTap: () => onSelect(emoji),
            child: Padding(
              padding: const EdgeInsets.all(4),
              child: Text(emoji, style: const TextStyle(fontSize: 24)),
            ),
          )),
          GestureDetector(
            onTap: onDismiss,
            child: Padding(
              padding: const EdgeInsets.all(4),
              child: Icon(Icons.close, size: 20, color: theme.colorScheme.onSurfaceVariant),
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
      spacing: 4,
      children: reactions.entries.map((entry) {
        final emoji = entry.key;
        final count = entry.value.length;
        return Container(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
          decoration: BoxDecoration(
            color: theme.colorScheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: theme.colorScheme.outlineVariant),
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

  // Const icons for better performance - avoid recreating icons on every build
  static const _queuedIcon = Icon(Icons.cloud_queue, size: 14, color: Colors.orange);
  static const _iconSize = 14.0;
  static const _progressSize = 12.0;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = theme.colorScheme.onPrimaryContainer.withOpacity(0.7);

    switch (status) {
      case MessageStatus.pending:
        return SizedBox(
          width: _progressSize,
          height: _progressSize,
          child: CircularProgressIndicator(
            strokeWidth: 1.5,
            color: color,
          ),
        );
      case MessageStatus.queued:
        return _queuedIcon;
      case MessageStatus.sent:
        return Icon(Icons.check, size: _iconSize, color: color);
      case MessageStatus.delivered:
        return Icon(Icons.done_all, size: _iconSize, color: color);
      case MessageStatus.failed:
        return Icon(Icons.error_outline, size: _iconSize, color: theme.colorScheme.error);
    }
  }
}

class _MessageInput extends StatelessWidget {
  const _MessageInput({
    required this.controller,
    required this.onSend,
  });

  final TextEditingController controller;
  final VoidCallback onSend;

  static const _inputBorderRadius = BorderRadius.all(Radius.circular(24));
  static const _contentPadding = EdgeInsets.symmetric(horizontal: 16, vertical: 10);
  static const _spacing = SizedBox(width: 8);
  static const _sendIcon = Icon(Icons.send);

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
              controller: controller,
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
              onSubmitted: (_) => onSend(),
            ),
          ),
          _spacing,
          IconButton.filled(
            onPressed: onSend,
            icon: _sendIcon,
          ),
        ],
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow({
    required this.label,
    required this.value,
    this.copyable = false,
  });

  final String label;
  final String value;
  final bool copyable;

  static const _copyIcon = Icon(Icons.copy, size: 18);
  static const _labelWidth = 100.0;
  static const _copiedSnackBar = SnackBar(content: Text('Copied to clipboard'));

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: _labelWidth,
          child: Text(
            label,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ),
        Expanded(
          child: Text(
            value.length > 20 && copyable
                ? '${value.substring(0, 8)}...${value.substring(value.length - 8)}'
                : value,
            style: theme.textTheme.bodyMedium?.copyWith(
              fontFamily: copyable ? 'monospace' : null,
            ),
          ),
        ),
        if (copyable)
          IconButton(
            icon: _copyIcon,
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: value));
              if (context.mounted) {
                ScaffoldMessenger.of(context).showSnackBar(_copiedSnackBar);
              }
            },
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(),
          ),
      ],
    );
  }
}

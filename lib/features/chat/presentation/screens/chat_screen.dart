import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../config/providers/auth_provider.dart';
import '../../../../config/providers/chat_provider.dart';
import '../../../../shared/utils/formatters.dart';
import '../../domain/models/message.dart';
import '../../domain/models/session.dart';
import '../widgets/chat_message_bubble.dart';
import '../widgets/message_input.dart';

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
  final _composerFocusNode = FocusNode();
  bool _isAtBottom = true;

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_onScroll);

    // Load messages and clear unread
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(chatStateProvider.notifier).loadMessages(widget.sessionId);
      ref.read(chatStateProvider.notifier).markSessionSeen(widget.sessionId);
      ref.read(sessionStateProvider.notifier).clearUnread(widget.sessionId);
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

    // Scroll to bottom
    WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());

    // Send message via provider (handles optimistic update, encryption, and Nostr)
    await ref
        .read(chatStateProvider.notifier)
        .sendMessage(widget.sessionId, text);

    // Update session metadata
    final messages = ref.read(sessionMessagesProvider(widget.sessionId));
    if (messages.isNotEmpty) {
      await ref
          .read(sessionStateProvider.notifier)
          .updateSessionWithMessage(widget.sessionId, messages.last);
    }
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

  static const _expirationOptions = <int>[
    5 * 60, // 5 minutes
    60 * 60, // 1 hour
    24 * 60 * 60, // 24 hours
    7 * 24 * 60 * 60, // 1 week
    30 * 24 * 60 * 60, // 1 month
    90 * 24 * 60 * 60, // 3 months
  ];

  static String _ttlLabel(int? ttlSeconds) {
    if (ttlSeconds == null || ttlSeconds <= 0) return 'Off';

    return switch (ttlSeconds) {
      300 => '5 minutes',
      3600 => '1 hour',
      86400 => '24 hours',
      604800 => '1 week',
      2592000 => '1 month',
      7776000 => '3 months',
      _ => () {
        const minute = 60;
        const hour = 60 * minute;
        const day = 24 * hour;
        if (ttlSeconds < minute) return '$ttlSeconds seconds';
        if (ttlSeconds < hour) return '${ttlSeconds ~/ minute} minutes';
        if (ttlSeconds < day) return '${ttlSeconds ~/ hour} hours';
        return '${ttlSeconds ~/ day} days';
      }(),
    };
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
    final isTyping = ref.watch(
      chatStateProvider.select(
        (s) => s.typingStates[widget.sessionId] ?? false,
      ),
    );
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: Text(session.displayName),
        actions: [
          IconButton(
            icon: const Icon(Icons.timer_outlined),
            tooltip: 'Disappearing messages',
            onPressed: () => _showDisappearingMessages(context, session),
          ),
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
                            onReply: () => _quoteReply(message),
                            onReact: (emoji) async {
                              final myPubkey =
                                  ref.read(authStateProvider).pubkeyHex ?? 'me';
                              await ref
                                  .read(chatStateProvider.notifier)
                                  .sendReaction(
                                    widget.sessionId,
                                    message.id,
                                    emoji,
                                    myPubkey,
                                  );
                            },
                            onDeleteLocal: () async {
                              await ref
                                  .read(chatStateProvider.notifier)
                                  .deleteMessageLocal(
                                    widget.sessionId,
                                    message.id,
                                  );
                              await ref
                                  .read(sessionStateProvider.notifier)
                                  .refreshSession(widget.sessionId);
                            },
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

          // Message input
          MessageInput(
            controller: _messageController,
            onSend: _sendMessage,
            autofocus: true,
            focusNode: _composerFocusNode,
            onChanged: (text) {
              if (text.trim().isEmpty) return;
              ref
                  .read(chatStateProvider.notifier)
                  .notifyTyping(widget.sessionId);
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
              Icons.lock_outline,
              size: 64,
              color: theme.colorScheme.outline,
            ),
            const SizedBox(height: 16),
            Text('End-to-end encrypted', style: theme.textTheme.titleMedium),
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
      isScrollControlled: true,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: SingleChildScrollView(
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
                const SizedBox(height: 12),
                _InfoRow(
                  label: 'Disappearing messages',
                  value: _ttlLabel(session.messageTtlSeconds),
                ),
                if (session.inviteId != null) ...[
                  const SizedBox(height: 12),
                  _InfoRow(label: 'Invite ID', value: session.inviteId!),
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
      ),
    );
  }

  void _showDisappearingMessages(BuildContext context, ChatSession session) {
    final theme = Theme.of(context);
    final current = session.messageTtlSeconds;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Disappearing messages',
                  style: theme.textTheme.titleLarge,
                ),
                const SizedBox(height: 8),
                Text(
                  'New messages will disappear after the selected time.',
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  'Current: ${_ttlLabel(current)}',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 16),
                _ExpirationOptionTile(
                  label: 'Off',
                  selected: current == null,
                  onTap: () async {
                    Navigator.pop(context);
                    await ref
                        .read(sessionStateProvider.notifier)
                        .setMessageTtlSeconds(session.id, null);
                    await ref
                        .read(chatStateProvider.notifier)
                        .sendChatSettingsSignal(session.id, null);
                  },
                ),
                const Divider(),
                ..._expirationOptions.map((ttl) {
                  return _ExpirationOptionTile(
                    label: _ttlLabel(ttl),
                    selected: current == ttl,
                    onTap: () async {
                      Navigator.pop(context);
                      await ref
                          .read(sessionStateProvider.notifier)
                          .setMessageTtlSeconds(session.id, ttl);
                      await ref
                          .read(chatStateProvider.notifier)
                          .sendChatSettingsSignal(session.id, ttl);
                    },
                  );
                }),
                const SizedBox(height: 8),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ExpirationOptionTile extends StatelessWidget {
  const _ExpirationOptionTile({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListTile(
      contentPadding: EdgeInsets.zero,
      title: Text(label),
      trailing: selected
          ? Icon(Icons.check, color: theme.colorScheme.primary)
          : null,
      onTap: onTap,
    );
  }
}

class _DateSeparator extends StatelessWidget {
  const _DateSeparator({required this.date});

  final DateTime date;

  static const _padding = EdgeInsets.symmetric(vertical: 16);
  static const _containerPadding = EdgeInsets.symmetric(
    horizontal: 12,
    vertical: 4,
  );
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

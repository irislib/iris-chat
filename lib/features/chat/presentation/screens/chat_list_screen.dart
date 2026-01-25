import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../config/providers/chat_provider.dart';
import '../../../../config/providers/invite_provider.dart';
import '../../../../shared/utils/formatters.dart';
import '../../domain/models/session.dart';
import '../widgets/offline_indicator.dart';

class ChatListScreen extends ConsumerStatefulWidget {
  const ChatListScreen({super.key});

  @override
  ConsumerState<ChatListScreen> createState() => _ChatListScreenState();
}

class _ChatListScreenState extends ConsumerState<ChatListScreen> {
  @override
  void initState() {
    super.initState();
    // Load sessions and invites on screen init
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(sessionStateProvider.notifier).loadSessions();
      ref.read(inviteStateProvider.notifier).loadInvites();
    });
  }

  void _showNewChatOptions() {
    showModalBottomSheet(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.qr_code),
              title: const Text('Create Invite'),
              subtitle: const Text('Share a link or QR code'),
              onTap: () {
                Navigator.pop(context);
                context.push('/invite/create');
              },
            ),
            ListTile(
              leading: const Icon(Icons.qr_code_scanner),
              title: const Text('Scan Invite'),
              subtitle: const Text('Scan a QR code or paste a link'),
              onTap: () {
                Navigator.pop(context);
                context.push('/invite/scan');
              },
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    // Optimized: Use select() to only watch isLoading and sessions, not the entire state
    final isLoading = ref.watch(sessionStateProvider.select((s) => s.isLoading));
    final sessions = ref.watch(sessionStateProvider.select((s) => s.sessions));
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Chats'),
        actions: [
          const Padding(
            padding: EdgeInsets.only(right: 8),
            child: ConnectionStatusIcon(size: 20),
          ),
          IconButton(
            icon: const Icon(Icons.settings),
            onPressed: () => context.push('/settings'),
          ),
        ],
      ),
      body: Column(
        children: [
          const OfflineBanner(),
          Expanded(
            child: isLoading
                ? const Center(child: CircularProgressIndicator())
                : sessions.isEmpty
                    ? _buildEmptyState(theme)
                    : _buildChatList(sessions),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: _showNewChatOptions,
        child: const Icon(Icons.add),
      ),
    );
  }

  Widget _buildEmptyState(ThemeData theme) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.chat_bubble_outline,
              size: 80,
              color: theme.colorScheme.outline,
            ),
            const SizedBox(height: 16),
            Text(
              'No conversations yet',
              style: theme.textTheme.headlineSmall,
            ),
            const SizedBox(height: 8),
            Text(
              'Start a new chat by creating an invite or scanning one from a friend.',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            FilledButton.icon(
              onPressed: _showNewChatOptions,
              icon: const Icon(Icons.add),
              label: const Text('Start a new chat'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildChatList(List<ChatSession> sessions) {
    return ListView.builder(
      itemCount: sessions.length,
      // Performance: Add cacheExtent for smoother scrolling
      cacheExtent: 80.0 * 3, // Cache ~3 items worth of height
      itemBuilder: (context, index) {
        final session = sessions[index];
        return _ChatListItem(
          key: ValueKey(session.id),
          session: session,
          onTap: () => context.push('/chats/${session.id}'),
          onDelete: () async {
            final confirmed = await showDialog<bool>(
              context: context,
              builder: (context) => AlertDialog(
                title: const Text('Delete conversation?'),
                content: const Text(
                  'This will delete all messages in this conversation. This action cannot be undone.',
                ),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.pop(context, false),
                    child: const Text('Cancel'),
                  ),
                  TextButton(
                    onPressed: () => Navigator.pop(context, true),
                    child: const Text('Delete'),
                  ),
                ],
              ),
            );
            if (confirmed ?? false) {
              await ref.read(sessionStateProvider.notifier).deleteSession(session.id);
            }
          },
        );
      },
    );
  }
}

class _ChatListItem extends StatelessWidget {
  const _ChatListItem({
    super.key,
    required this.session,
    required this.onTap,
    required this.onDelete,
  });

  final ChatSession session;
  final VoidCallback onTap;
  final VoidCallback onDelete;

  static const _dismissiblePadding = EdgeInsets.only(right: 16);
  static const _unreadBadgePadding = EdgeInsets.symmetric(horizontal: 8, vertical: 2);
  static const _unreadBadgeBorderRadius = BorderRadius.all(Radius.circular(12));
  static const _unreadSpacing = SizedBox(height: 4);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Dismissible(
      key: Key(session.id),
      direction: DismissDirection.endToStart,
      background: Container(
        color: theme.colorScheme.error,
        alignment: Alignment.centerRight,
        padding: _dismissiblePadding,
        child: Icon(Icons.delete, color: theme.colorScheme.onError),
      ),
      onDismissed: (_) => onDelete(),
      child: ListTile(
        leading: CircleAvatar(
          backgroundColor: theme.colorScheme.primaryContainer,
          child: Text(
            session.displayName[0].toUpperCase(),
            style: TextStyle(color: theme.colorScheme.onPrimaryContainer),
          ),
        ),
        title: Text(
          session.displayName,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        subtitle: session.lastMessagePreview != null
            ? Text(
                session.lastMessagePreview!,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              )
            : null,
        trailing: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            if (session.lastMessageAt != null)
              Text(
                formatRelativeDateTime(session.lastMessageAt!),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            if (session.unreadCount > 0) ...[
              _unreadSpacing,
              Container(
                padding: _unreadBadgePadding,
                decoration: BoxDecoration(
                  color: theme.colorScheme.primary,
                  borderRadius: _unreadBadgeBorderRadius,
                ),
                child: Text(
                  session.unreadCount.toString(),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onPrimary,
                  ),
                ),
              ),
            ],
          ],
        ),
        onTap: onTap,
      ),
    );
  }
}

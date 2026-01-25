import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../config/providers/chat_provider.dart';
import '../../../../config/providers/invite_provider.dart';
import '../../../../config/providers/nostr_provider.dart';
import '../../../../shared/utils/formatters.dart';
import '../../domain/models/session.dart';
import '../widgets/offline_indicator.dart';

class ChatListScreen extends ConsumerStatefulWidget {
  const ChatListScreen({super.key});

  @override
  ConsumerState<ChatListScreen> createState() => _ChatListScreenState();
}

class _ChatListScreenState extends ConsumerState<ChatListScreen> {
  bool _initialLoadDone = false;
  bool _redirected = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      await ref.read(sessionStateProvider.notifier).loadSessions();
      ref.read(inviteStateProvider.notifier).loadInvites();
      // Start message subscription
      ref.read(messageSubscriptionProvider);
      if (mounted) {
        setState(() => _initialLoadDone = true);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final isLoading = ref.watch(sessionStateProvider.select((s) => s.isLoading));
    final sessions = ref.watch(sessionStateProvider.select((s) => s.sessions));

    // Redirect to new chat if empty (only once after initial load completes)
    if (_initialLoadDone && !isLoading && sessions.isEmpty && !_redirected) {
      _redirected = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        context.go('/chats/new');
      });
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('Iris'),
        actions: [
          IconButton(
            icon: const Icon(Icons.add),
            onPressed: () => context.push('/chats/new'),
            tooltip: 'New Chat',
          ),
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
                : _buildChatList(sessions),
          ),
        ],
      ),
    );
  }

  Widget _buildChatList(List<ChatSession> sessions) {
    return ListView.builder(
      itemCount: sessions.length,
      cacheExtent: 80.0 * 3,
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

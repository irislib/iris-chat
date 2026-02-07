import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../config/providers/chat_provider.dart';
import '../../../../config/providers/invite_provider.dart';
import '../../../../config/providers/nostr_provider.dart';
import '../../../../shared/utils/formatters.dart';
import '../../domain/models/group.dart';
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
      await ref.read(groupStateProvider.notifier).loadGroups();
      await ref.read(inviteStateProvider.notifier).loadInvites();
      // Start message subscription
      ref.read(messageSubscriptionProvider);
      if (mounted) {
        setState(() => _initialLoadDone = true);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final sessionsLoading =
        ref.watch(sessionStateProvider.select((s) => s.isLoading));
    final groupsLoading = ref.watch(groupStateProvider.select((s) => s.isLoading));
    final sessions = ref.watch(sessionStateProvider.select((s) => s.sessions));
    final groups = ref.watch(groupStateProvider.select((s) => s.groups));
    // Don't block showing existing sessions while group metadata is still loading.
    final showInitialLoading =
        (sessionsLoading || groupsLoading) && sessions.isEmpty && groups.isEmpty;

    // Redirect to new chat if empty (only once after initial load completes)
    if (_initialLoadDone &&
        !sessionsLoading &&
        !groupsLoading &&
        sessions.isEmpty &&
        groups.isEmpty &&
        !_redirected) {
      _redirected = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final router = GoRouter.maybeOf(context);
        if (router != null) {
          router.go('/chats/new');
        }
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
            child: showInitialLoading
                ? const Center(child: CircularProgressIndicator())
                : _buildChatList(sessions: sessions, groups: groups),
          ),
        ],
      ),
    );
  }

  Widget _buildChatList({
    required List<ChatSession> sessions,
    required List<ChatGroup> groups,
  }) {
    final threads = <_Thread>[
      ...groups.map(_Thread.group),
      ...sessions.map(_Thread.session),
    ]..sort((a, b) => b.sortTime.compareTo(a.sortTime));

    return ListView.builder(
      itemCount: threads.length,
      cacheExtent: 80.0 * 3,
      itemBuilder: (context, index) {
        final thread = threads[index];
        final group = thread.group;
        if (group != null) {
          return _GroupListItem(
            key: ValueKey('group:${group.id}'),
            group: group,
            onTap: () => context.push('/groups/${group.id}'),
            onDelete: () async {
              final confirmed = await showDialog<bool>(
                context: context,
                builder: (context) => AlertDialog(
                  title: const Text('Delete group?'),
                  content: const Text(
                    'This will delete the group and all its messages from this device. This action cannot be undone.',
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
                await ref.read(groupStateProvider.notifier).deleteGroup(group.id);
              }
            },
          );
        }

        final session = thread.session!;
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

class _Thread {
  const _Thread._({this.session, this.group});

  factory _Thread.session(ChatSession session) => _Thread._(session: session);
  factory _Thread.group(ChatGroup group) => _Thread._(group: group);

  final ChatSession? session;
  final ChatGroup? group;

  DateTime get sortTime {
    final s = session;
    if (s != null) {
      return s.lastMessageAt ?? s.createdAt;
    }
    final g = group!;
    return g.lastMessageAt ?? g.createdAt;
  }
}

class _GroupListItem extends StatelessWidget {
  const _GroupListItem({
    super.key,
    required this.group,
    required this.onTap,
    required this.onDelete,
  });

  final ChatGroup group;
  final VoidCallback onTap;
  final VoidCallback onDelete;

  static const _dismissiblePadding = EdgeInsets.only(right: 16);
  static const _unreadBadgePadding = EdgeInsets.symmetric(horizontal: 8, vertical: 2);
  static const _unreadBadgeBorderRadius = BorderRadius.all(Radius.circular(12));
  static const _unreadSpacing = SizedBox(height: 4);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final subtitle = group.accepted
        ? group.lastMessagePreview
        : (group.lastMessagePreview ?? 'Group invitation');

    return Dismissible(
      key: Key('group:${group.id}'),
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
          backgroundColor: theme.colorScheme.secondaryContainer,
          child: Icon(
            Icons.groups,
            color: theme.colorScheme.onSecondaryContainer,
          ),
        ),
        title: Text(
          group.name,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        subtitle: subtitle != null
            ? Text(
                subtitle,
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
            if (group.lastMessageAt != null)
              Text(
                formatRelativeDateTime(group.lastMessageAt!),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            if (group.unreadCount > 0) ...[
              _unreadSpacing,
              Container(
                padding: _unreadBadgePadding,
                decoration: BoxDecoration(
                  color: theme.colorScheme.primary,
                  borderRadius: _unreadBadgeBorderRadius,
                ),
                child: Text(
                  group.unreadCount.toString(),
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

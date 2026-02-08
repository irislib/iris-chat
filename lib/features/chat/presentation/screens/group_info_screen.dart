import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../config/providers/auth_provider.dart';
import '../../../../config/providers/chat_provider.dart';
import '../../../../shared/utils/formatters.dart';
import '../../domain/models/group.dart';
import '../../domain/models/session.dart';

class GroupInfoScreen extends ConsumerStatefulWidget {
  const GroupInfoScreen({super.key, required this.groupId});

  final String groupId;

  @override
  ConsumerState<GroupInfoScreen> createState() => _GroupInfoScreenState();
}

class _GroupInfoScreenState extends ConsumerState<GroupInfoScreen> {
  final Set<String> _selectedToAdd = <String>{};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // Best-effort: navigation can happen before the list screen initializes.
      ref.read(groupStateProvider.notifier).loadGroups();
    });
  }

  Future<void> _showRenameDialog(ChatGroup group) async {
    final controller = TextEditingController(text: group.name);
    try {
      final result = await showDialog<String?>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Rename Group'),
          content: TextField(
            controller: controller,
            autofocus: true,
            decoration: const InputDecoration(
              labelText: 'Group name',
              border: OutlineInputBorder(),
            ),
            onSubmitted: (value) => Navigator.of(context).pop(value),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(null),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(controller.text),
              child: const Text('Save'),
            ),
          ],
        ),
      );

      final next = result?.trim();
      if (next == null || next.isEmpty) return;

      await ref.read(groupStateProvider.notifier).renameGroup(widget.groupId, next);
      if (!mounted) return;

      final error = ref.read(groupStateProvider).error;
      if (error != null) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error)));
      }
    } finally {
      controller.dispose();
    }
  }

  Future<void> _addSelectedMembers() async {
    final group = _findGroup(ref.read(groupStateProvider).groups);
    if (group == null) return;

    final toAdd = _selectedToAdd.toList();
    if (toAdd.isEmpty) return;

    await ref.read(groupStateProvider.notifier).addGroupMembers(widget.groupId, toAdd);
    if (!mounted) return;

    setState(_selectedToAdd.clear);

    final error = ref.read(groupStateProvider).error;
    if (error != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error)));
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Added ${toAdd.length} member${toAdd.length == 1 ? '' : 's'}')),
    );
  }

  Future<void> _confirmRemoveMember(ChatGroup group, String memberPubkeyHex) async {
    final short = formatPubkeyForDisplay(memberPubkeyHex);
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Remove Member'),
        content: Text('Remove $short from this group?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Remove'),
          ),
        ],
      ),
    );
    if (ok != true) return;

    await ref
        .read(groupStateProvider.notifier)
        .removeGroupMember(widget.groupId, memberPubkeyHex);
    if (!mounted) return;

    final error = ref.read(groupStateProvider).error;
    if (error != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error)));
    }
  }

  ChatGroup? _findGroup(List<ChatGroup> groups) {
    for (final g in groups) {
      if (g.id == widget.groupId) return g;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final groups = ref.watch(groupStateProvider.select((s) => s.groups));
    final group = _findGroup(groups);

    if (group == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Group Info')),
        body: const Center(child: CircularProgressIndicator()),
      );
    }

    final authState = ref.watch(authStateProvider);
    final myPubkeyHex = authState.pubkeyHex;
    final isAdmin =
        myPubkeyHex != null && myPubkeyHex.isNotEmpty && group.admins.contains(myPubkeyHex);

    final sessions = ref.watch(sessionStateProvider.select((s) => s.sessions));
    final candidates = sessions
        .where((s) => !group.members.contains(s.recipientPubkeyHex))
        .toList()
      ..sort(
        (a, b) => a.displayName.toLowerCase().compareTo(b.displayName.toLowerCase()),
      );

    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Group Info'),
        actions: [
          if (isAdmin)
            IconButton(
              icon: const Icon(Icons.edit),
              onPressed: () => _showRenameDialog(group),
              tooltip: 'Rename',
            ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            elevation: 0,
            color: theme.colorScheme.surfaceContainerHighest,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    group.name,
                    style: theme.textTheme.titleLarge?.copyWith(
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 8),
                  _CopyRow(label: 'Group ID', value: group.id),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          Text(
            'Members',
            style: theme.textTheme.titleMedium?.copyWith(
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 8),
          Card(
            elevation: 0,
            color: theme.colorScheme.surfaceContainerHighest,
            child: Column(
              children: [
                for (final pk in group.members)
                  _MemberTile(
                    pubkeyHex: pk,
                    myPubkeyHex: myPubkeyHex,
                    isAdmin: isAdmin,
                    isMemberAdmin: group.admins.contains(pk),
                    sessions: sessions,
                    onRemove: () => _confirmRemoveMember(group, pk),
                  ),
              ],
            ),
          ),
          if (isAdmin) ...[
            const SizedBox(height: 24),
            Text(
              'Add Members',
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 8),
            Card(
              elevation: 0,
              color: theme.colorScheme.surfaceContainerHighest,
              child: Padding(
                padding: const EdgeInsets.all(8),
                child: Column(
                  children: [
                    if (candidates.isEmpty)
                      Padding(
                        padding: const EdgeInsets.all(12),
                        child: Text(
                          'No one else to add yet.',
                          style: theme.textTheme.bodyMedium?.copyWith(
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                        ),
                      )
                    else
                      for (final s in candidates)
                        CheckboxListTile(
                          value: _selectedToAdd.contains(s.recipientPubkeyHex),
                          onChanged: (v) {
                            setState(() {
                              if (v ?? false) {
                                _selectedToAdd.add(s.recipientPubkeyHex);
                              } else {
                                _selectedToAdd.remove(s.recipientPubkeyHex);
                              }
                            });
                          },
                          title: Text(s.displayName),
                          subtitle: Text(formatPubkeyForDisplay(s.recipientPubkeyHex)),
                          dense: true,
                        ),
                    const SizedBox(height: 8),
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton(
                        onPressed: _selectedToAdd.isEmpty ? null : _addSelectedMembers,
                        child: const Text('Add Selected'),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _CopyRow extends StatelessWidget {
  const _CopyRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                value,
                style: theme.textTheme.bodyMedium?.copyWith(fontFamily: 'monospace'),
              ),
            ],
          ),
        ),
        IconButton(
          icon: const Icon(Icons.copy, size: 18),
          tooltip: 'Copy',
          onPressed: () async {
            await Clipboard.setData(ClipboardData(text: value));
            if (context.mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Copied')),
              );
            }
          },
        ),
      ],
    );
  }
}

class _MemberTile extends StatelessWidget {
  const _MemberTile({
    required this.pubkeyHex,
    required this.myPubkeyHex,
    required this.isAdmin,
    required this.isMemberAdmin,
    required this.sessions,
    required this.onRemove,
  });

  final String pubkeyHex;
  final String? myPubkeyHex;
  final bool isAdmin;
  final bool isMemberAdmin;
  final List<ChatSession> sessions;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final me = myPubkeyHex != null && myPubkeyHex!.isNotEmpty && pubkeyHex == myPubkeyHex;

    ChatSession? session;
    for (final s in sessions) {
      if (s.recipientPubkeyHex == pubkeyHex) {
        session = s;
        break;
      }
    }

    final title = me ? 'You' : (session?.displayName ?? 'Member');
    final subtitle = formatPubkeyForDisplay(pubkeyHex);

    return ListTile(
      title: Row(
        children: [
          Expanded(child: Text(title)),
          if (isMemberAdmin)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                color: theme.colorScheme.primaryContainer,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Text(
                'Admin',
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onPrimaryContainer,
                ),
              ),
            ),
        ],
      ),
      subtitle: Text(
        subtitle,
        style: theme.textTheme.bodySmall?.copyWith(fontFamily: 'monospace'),
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          IconButton(
            icon: const Icon(Icons.copy, size: 18),
            tooltip: 'Copy pubkey',
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: pubkeyHex));
              if (context.mounted) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('Copied')),
                );
              }
            },
          ),
          if (isAdmin && !me)
            IconButton(
              icon: const Icon(Icons.remove_circle_outline),
              tooltip: 'Remove',
              color: theme.colorScheme.error,
              onPressed: onRemove,
            ),
        ],
      ),
    );
  }
}

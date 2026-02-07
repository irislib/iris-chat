import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../config/providers/chat_provider.dart';
import '../../../../shared/utils/formatters.dart';

class CreateGroupScreen extends ConsumerStatefulWidget {
  const CreateGroupScreen({super.key});

  @override
  ConsumerState<CreateGroupScreen> createState() => _CreateGroupScreenState();
}

class _CreateGroupScreenState extends ConsumerState<CreateGroupScreen> {
  final _nameController = TextEditingController();
  final Set<String> _selectedMembers = <String>{};
  bool _creating = false;

  @override
  void dispose() {
    _nameController.dispose();
    super.dispose();
  }

  Future<void> _create() async {
    final name = _nameController.text.trim();
    if (name.isEmpty) return;
    if (_selectedMembers.isEmpty) return;
    if (_creating) return;

    setState(() => _creating = true);
    try {
      final groupId = await ref.read(groupStateProvider.notifier).createGroup(
            name: name,
            memberPubkeysHex: _selectedMembers.toList(),
          );
      if (!mounted) return;

      if (groupId == null) {
        final error = ref.read(groupStateProvider).error;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(error ?? 'Failed to create group')),
        );
        return;
      }

      context.go('/groups/$groupId');
    } finally {
      if (mounted) setState(() => _creating = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final sessions = ref.watch(sessionStateProvider.select((s) => s.sessions));
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('New Group'),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextField(
                  controller: _nameController,
                  decoration: const InputDecoration(
                    labelText: 'Group name',
                    border: OutlineInputBorder(),
                  ),
                  textCapitalization: TextCapitalization.words,
                  enabled: !_creating,
                  onChanged: (_) => setState(() {}),
                ),
                const SizedBox(height: 12),
                Text(
                  'Members',
                  style: theme.textTheme.titleSmall,
                ),
                const SizedBox(height: 8),
                Text(
                  'Pick from people you already have chats with.',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          const Divider(height: 1),
          Expanded(
            child: sessions.isEmpty
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text(
                        'Start a 1:1 chat first so they appear here.',
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                        textAlign: TextAlign.center,
                      ),
                    ),
                  )
                : ListView.builder(
                    itemCount: sessions.length,
                    itemBuilder: (context, index) {
                      final s = sessions[index];
                      final selected = _selectedMembers.contains(s.recipientPubkeyHex);
                      return CheckboxListTile(
                        value: selected,
                        onChanged: _creating
                            ? null
                              : (v) {
                                  setState(() {
                                  if (v ?? false) {
                                    _selectedMembers.add(s.recipientPubkeyHex);
                                  } else {
                                    _selectedMembers.remove(s.recipientPubkeyHex);
                                  }
                                });
                              },
                        title: Text(s.displayName),
                        subtitle: Text(formatPubkeyForDisplay(s.recipientPubkeyHex)),
                      );
                    },
                  ),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: (_creating || _nameController.text.trim().isEmpty || _selectedMembers.isEmpty)
                      ? null
                      : _create,
                  child: _creating
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('Create Group'),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

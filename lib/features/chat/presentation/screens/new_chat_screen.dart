import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../../../../config/providers/chat_provider.dart';
import '../../../../config/providers/invite_provider.dart';
import '../../../../shared/utils/formatters.dart';
import '../../../invite/domain/models/invite.dart';
import '../widgets/offline_indicator.dart';

class NewChatScreen extends ConsumerStatefulWidget {
  const NewChatScreen({super.key});

  @override
  ConsumerState<NewChatScreen> createState() => _NewChatScreenState();
}

class _NewChatScreenState extends ConsumerState<NewChatScreen> {
  final _pasteController = TextEditingController();
  bool _isJoining = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      await ref.read(inviteStateProvider.notifier).loadInvites();
      final invites = ref.read(inviteStateProvider).invites;
      if (invites.isEmpty) {
        _createInvite();
      }
    });
  }

  @override
  void dispose() {
    _pasteController.dispose();
    super.dispose();
  }

  Future<void> _createInvite() async {
    final invites = ref.read(inviteStateProvider).invites;
    final label = 'Invite #${invites.length + 1}';
    await ref.read(inviteStateProvider.notifier).createInvite(label: label);
  }

  Future<void> _joinChat() async {
    final url = _pasteController.text.trim();
    if (url.isEmpty || _isJoining) return;

    setState(() => _isJoining = true);
    try {
      final sessionId = await ref.read(inviteStateProvider.notifier).acceptInviteFromUrl(url);
      if (sessionId != null && mounted) {
        context.go('/chats/$sessionId');
      } else if (mounted) {
        final error = ref.read(inviteStateProvider).error;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(error ?? 'Invalid invite')),
        );
      }
    } finally {
      if (mounted) setState(() => _isJoining = false);
    }
  }

  void _onPasteChanged(String value) {
    if (value.contains('iris.to') || value.contains('#invite')) {
      _joinChat();
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final sessions = ref.watch(sessionStateProvider.select((s) => s.sessions));
    final hasChats = sessions.isNotEmpty;
    final inviteState = ref.watch(inviteStateProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Iris'),
        leading: hasChats
            ? IconButton(icon: const Icon(Icons.arrow_back), onPressed: () => context.go('/chats'))
            : null,
        automaticallyImplyLeading: false,
        actions: [
          const Padding(padding: EdgeInsets.only(right: 8), child: ConnectionStatusIcon(size: 20)),
          IconButton(icon: const Icon(Icons.settings), onPressed: () => context.push('/settings')),
        ],
      ),
      body: Column(
        children: [
          const OfflineBanner(),
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // Join Chat card
                  _JoinChatCard(
                    controller: _pasteController,
                    isJoining: _isJoining,
                    onJoin: _joinChat,
                    onChanged: _onPasteChanged,
                    onScanQR: () => context.push('/invite/scan'),
                  ),
                  const SizedBox(height: 16),
                  // New Chat card
                  _NewChatCard(
                    invites: inviteState.invites,
                    isCreating: inviteState.isCreating,
                    onCreateInvite: _createInvite,
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _JoinChatCard extends StatelessWidget {
  const _JoinChatCard({
    required this.controller,
    required this.isJoining,
    required this.onJoin,
    required this.onChanged,
    required this.onScanQR,
  });

  final TextEditingController controller;
  final bool isJoining;
  final VoidCallback onJoin;
  final ValueChanged<String> onChanged;
  final VoidCallback onScanQR;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      elevation: 0,
      color: theme.colorScheme.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Join Chat', style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold)),
            const SizedBox(height: 12),
            TextField(
              controller: controller,
              decoration: const InputDecoration(
                hintText: 'Paste invite link',
                border: OutlineInputBorder(),
                contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 12),
              ),
              onChanged: onChanged,
              onSubmitted: (_) => onJoin(),
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: onScanQR,
              icon: const Icon(Icons.qr_code_scanner),
              label: const Text('Scan QR Code'),
            ),
          ],
        ),
      ),
    );
  }
}

class _NewChatCard extends ConsumerWidget {
  const _NewChatCard({
    required this.invites,
    required this.isCreating,
    required this.onCreateInvite,
  });

  final List<Invite> invites;
  final bool isCreating;
  final VoidCallback onCreateInvite;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    return Card(
      elevation: 0,
      color: theme.colorScheme.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('New Chat', style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.bold)),
            const SizedBox(height: 4),
            Text('Share an invite link to start a chat', style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
            const SizedBox(height: 12),
            if (invites.isEmpty && isCreating)
              const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()))
            else ...[
              ...invites.map((invite) => _InviteItem(key: ValueKey(invite.id), invite: invite)),
              const SizedBox(height: 8),
              OutlinedButton.icon(
                onPressed: isCreating ? null : onCreateInvite,
                icon: isCreating
                    ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.add),
                label: const Text('Create New Invite'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _InviteItem extends ConsumerStatefulWidget {
  const _InviteItem({super.key, required this.invite});
  final Invite invite;

  @override
  ConsumerState<_InviteItem> createState() => _InviteItemState();
}

class _InviteItemState extends ConsumerState<_InviteItem> {
  bool _isEditing = false;
  late TextEditingController _labelController;

  @override
  void initState() {
    super.initState();
    _labelController = TextEditingController(text: widget.invite.label ?? '');
  }

  @override
  void dispose() {
    _labelController.dispose();
    super.dispose();
  }

  Future<void> _saveLabel() async {
    await ref.read(inviteStateProvider.notifier).updateLabel(widget.invite.id, _labelController.text);
    setState(() => _isEditing = false);
  }

  Future<void> _copyInvite() async {
    final url = await ref.read(inviteStateProvider.notifier).getInviteUrl(widget.invite.id);
    if (url != null) {
      await Clipboard.setData(ClipboardData(text: url));
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied'), duration: Duration(seconds: 1)));
      }
    }
  }

  Future<void> _shareInvite() async {
    final url = await ref.read(inviteStateProvider.notifier).getInviteUrl(widget.invite.id);
    if (url != null) {
      await Share.share(url, subject: 'Iris Chat Invite');
    }
  }

  void _showQRModal() async {
    final url = await ref.read(inviteStateProvider.notifier).getInviteUrl(widget.invite.id);
    if (url != null && mounted) {
      showDialog(
        context: context,
        builder: (context) => _QRModal(url: url, label: widget.invite.label),
      );
    }
  }

  Future<void> _deleteInvite() async {
    await ref.read(inviteStateProvider.notifier).deleteInvite(widget.invite.id);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Label row
          Row(
            children: [
              if (_isEditing) ...[
                Expanded(
                  child: TextField(
                    controller: _labelController,
                    autofocus: true,
                    decoration: const InputDecoration(
                      isDense: true,
                      contentPadding: EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                      border: OutlineInputBorder(),
                    ),
                    onSubmitted: (_) => _saveLabel(),
                  ),
                ),
                IconButton(icon: const Icon(Icons.check, color: Colors.green), onPressed: _saveLabel, iconSize: 20),
                IconButton(icon: const Icon(Icons.close, color: Colors.red), onPressed: () => setState(() => _isEditing = false), iconSize: 20),
              ] else ...[
                Expanded(
                  child: GestureDetector(
                    onTap: () => setState(() => _isEditing = true),
                    child: Row(
                      children: [
                        Text(
                          widget.invite.label ?? 'Add label...',
                          style: theme.textTheme.bodyMedium?.copyWith(
                            fontWeight: FontWeight.w500,
                            fontStyle: widget.invite.label == null ? FontStyle.italic : null,
                            color: widget.invite.label == null ? theme.colorScheme.onSurfaceVariant : null,
                          ),
                        ),
                        const SizedBox(width: 4),
                        Icon(Icons.edit, size: 14, color: theme.colorScheme.onSurfaceVariant),
                      ],
                    ),
                  ),
                ),
                Text(
                  formatRelativeDateTime(widget.invite.createdAt),
                  style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
                ),
              ],
            ],
          ),
          const SizedBox(height: 8),
          // Action buttons
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _copyInvite,
                  icon: const Icon(Icons.copy, size: 16),
                  label: const Text('Copy'),
                  style: OutlinedButton.styleFrom(visualDensity: VisualDensity.compact),
                ),
              ),
              const SizedBox(width: 8),
              IconButton(
                onPressed: _showQRModal,
                icon: const Icon(Icons.qr_code),
                tooltip: 'Show QR',
                style: IconButton.styleFrom(backgroundColor: theme.colorScheme.surfaceContainerHighest),
              ),
              IconButton(
                onPressed: _shareInvite,
                icon: const Icon(Icons.share),
                tooltip: 'Share',
              ),
              IconButton(
                onPressed: _deleteInvite,
                icon: Icon(Icons.delete_outline, color: theme.colorScheme.error),
                tooltip: 'Delete',
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _QRModal extends StatelessWidget {
  const _QRModal({required this.url, this.label});
  final String url;
  final String? label;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Dialog(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(label ?? 'Invite QR Code', style: theme.textTheme.titleLarge),
                IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(context)),
              ],
            ),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12)),
              child: QrImageView(data: url, version: QrVersions.auto, size: 250, backgroundColor: Colors.white),
            ),
            const SizedBox(height: 16),
            Text('Scan this code to start a chat', style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant)),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: url));
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied'), duration: Duration(seconds: 1)));
                }
              },
              icon: const Icon(Icons.copy),
              label: const Text('Copy Link'),
            ),
          ],
        ),
      ),
    );
  }
}

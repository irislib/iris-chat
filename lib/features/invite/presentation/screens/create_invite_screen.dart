import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../../../../config/providers/invite_provider.dart';

class CreateInviteScreen extends ConsumerStatefulWidget {
  const CreateInviteScreen({super.key});

  @override
  ConsumerState<CreateInviteScreen> createState() => _CreateInviteScreenState();
}

class _CreateInviteScreenState extends ConsumerState<CreateInviteScreen> {
  final _labelController = TextEditingController();
  String? _inviteUrl;
  String? _currentInviteId;

  @override
  void initState() {
    super.initState();
    // Create an invite immediately, unless we're already in a creating state.
    // This makes the screen more testable and avoids double-creating invites.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final inviteState = ref.read(inviteStateProvider);
      if (!inviteState.isCreating) {
        _createInvite();
      }
    });
  }

  @override
  void dispose() {
    _labelController.dispose();
    super.dispose();
  }

  Future<void> _createInvite() async {
    final invite = await ref.read(inviteStateProvider.notifier).createInvite(
          label: _labelController.text.isNotEmpty ? _labelController.text : null,
        );

    if (invite != null && mounted) {
      final url = await ref
          .read(inviteStateProvider.notifier)
          .getInviteUrl(invite.id);
      setState(() {
        _currentInviteId = invite.id;
        _inviteUrl = url;
      });
    }
  }

  Future<void> _copyToClipboard() async {
    if (_inviteUrl == null) return;

    await Clipboard.setData(ClipboardData(text: _inviteUrl!));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Copied to clipboard'),
          duration: Duration(seconds: 2),
        ),
      );
    }
  }

  Future<void> _share() async {
    if (_inviteUrl == null) return;

    await Share.share(
      _inviteUrl!,
      subject: 'Iris Chat Invite',
    );
  }

  @override
  Widget build(BuildContext context) {
    final inviteState = ref.watch(inviteStateProvider);
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Create Invite'),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Label input
            TextField(
              controller: _labelController,
              decoration: const InputDecoration(
                labelText: 'Label (optional)',
                hintText: 'e.g., "For Alice"',
                border: OutlineInputBorder(),
              ),
              onChanged: (value) async {
                if (_currentInviteId != null) {
                  await ref
                      .read(inviteStateProvider.notifier)
                      .updateLabel(_currentInviteId!, value);
                }
              },
            ),
            const SizedBox(height: 24),

            // QR Code
            if (inviteState.isCreating)
              const Center(
                child: Padding(
                  padding: EdgeInsets.all(48),
                  child: CircularProgressIndicator(),
                ),
              )
            else if (_inviteUrl != null) ...[
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(16),
                ),
                child: QrImageView(
                  data: _inviteUrl!,
                  version: QrVersions.auto,
                  size: 250,
                  backgroundColor: Colors.white,
                ),
              ),
              const SizedBox(height: 16),

              // URL display
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: theme.colorScheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  _inviteUrl!,
                  style: theme.textTheme.bodySmall?.copyWith(
                    fontFamily: 'monospace',
                  ),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(height: 24),

              // Action buttons
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: _copyToClipboard,
                      icon: const Icon(Icons.copy),
                      label: const Text('Copy'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: _share,
                      icon: const Icon(Icons.share),
                      label: const Text('Share'),
                    ),
                  ),
                ],
              ),
            ],

            const SizedBox(height: 32),

            // Info text
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: theme.colorScheme.primaryContainer.withValues(alpha: 77),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Row(
                children: [
                  Icon(
                    Icons.info_outline,
                    color: theme.colorScheme.primary,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      'Share this invite link or QR code with someone to start an encrypted conversation.',
                      style: theme.textTheme.bodyMedium,
                    ),
                  ),
                ],
              ),
            ),

            // Error display
            if (inviteState.error != null) ...[
              const SizedBox(height: 16),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: theme.colorScheme.errorContainer,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  inviteState.error!,
                  style: TextStyle(color: theme.colorScheme.onErrorContainer),
                ),
              ),
            ],

            const SizedBox(height: 24),

            // Create new invite button
            TextButton.icon(
              onPressed: inviteState.isCreating ? null : _createInvite,
              icon: const Icon(Icons.refresh),
              label: const Text('Create New Invite'),
            ),
          ],
        ),
      ),
    );
  }
}

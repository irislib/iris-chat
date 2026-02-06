import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../../../../config/providers/auth_provider.dart';
import '../../../../config/providers/nostr_provider.dart';
import '../../../../core/ffi/ndr_ffi.dart';
import '../../../../core/services/nostr_service.dart';
import '../../../../core/utils/invite_url.dart';

class LinkDeviceScreen extends ConsumerStatefulWidget {
  const LinkDeviceScreen({super.key});

  @override
  ConsumerState<LinkDeviceScreen> createState() => _LinkDeviceScreenState();
}

class _LinkDeviceScreenState extends ConsumerState<LinkDeviceScreen> {
  bool _isLoading = true;
  String? _error;
  String? _inviteUrl;
  String? _devicePrivkeyHex;
  InviteHandle? _inviteHandle;

  StreamSubscription<NostrEvent>? _eventSub;
  String? _subid;
  bool _handledAcceptance = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _createLinkInvite());
  }

  @override
  void dispose() {
    _cleanupSubscription();
    // Best-effort; this is a native handle.
    unawaited(_inviteHandle?.dispose());
    _inviteHandle = null;
    super.dispose();
  }

  Future<void> _cleanupSubscription() async {
    final subid = _subid;
    _subid = null;
    if (subid != null) {
      ref.read(nostrServiceProvider).closeSubscription(subid);
    }
    await _eventSub?.cancel();
    _eventSub = null;
  }

  Future<void> _createLinkInvite() async {
    await _cleanupSubscription();
    await _inviteHandle?.dispose();
    _inviteHandle = null;

    setState(() {
      _handledAcceptance = false;
      _isLoading = true;
      _error = null;
      _inviteUrl = null;
      _devicePrivkeyHex = null;
    });

    try {
      final nostrService = ref.read(nostrServiceProvider);
      await nostrService.connect();

      final keypair = await NdrFfi.generateKeypair();
      _devicePrivkeyHex = keypair.privateKeyHex;

      final invite = await NdrFfi.createInvite(
        inviterPubkeyHex: keypair.publicKeyHex,
        deviceId: keypair.publicKeyHex,
        maxUses: 1,
      );
      await invite.setPurpose('link');

      final url = await invite.toUrl('https://iris.to');

      final data = decodeInviteUrlData(url) ?? const <String, dynamic>{};
      final eph =
          (data['ephemeralKey'] ?? data['inviterEphemeralPublicKey']) as String?;
      if (eph == null || eph.isEmpty) {
        throw Exception('Invalid invite URL (missing ephemeral key)');
      }

      setState(() {
        _inviteHandle = invite;
        _inviteUrl = url;
        _isLoading = false;
      });

      _subscribeForAcceptance(nostrService, eph);
    } catch (e) {
      setState(() {
        _isLoading = false;
        _error = e.toString();
      });
    }
  }

  void _subscribeForAcceptance(NostrService nostrService, String ephPubkeyHex) {
    final subid = 'link-invite-${DateTime.now().microsecondsSinceEpoch}';
    _subid = subid;

    // Listen first to avoid missing fast responses.
    _eventSub = nostrService.events.listen((event) async {
      if (_handledAcceptance) return;
      if (event.subscriptionId != subid) return;
      if (event.kind != 1059) return;

      final inviteHandle = _inviteHandle;
      final devicePrivkeyHex = _devicePrivkeyHex;
      if (inviteHandle == null || devicePrivkeyHex == null) return;

      try {
        final result = await inviteHandle.processResponse(
          eventJson: jsonEncode(event.toJson()),
          inviterPrivkeyHex: devicePrivkeyHex,
        );
        if (result == null) return;

        final ownerPubkeyHex = result.ownerPubkeyHex ?? result.inviteePubkeyHex;

        _handledAcceptance = true;
        await _cleanupSubscription();
        await inviteHandle.dispose();
        _inviteHandle = null;

        await ref.read(authStateProvider.notifier).loginLinkedDevice(
              ownerPubkeyHex: ownerPubkeyHex,
              devicePrivkeyHex: devicePrivkeyHex,
            );

        if (mounted) {
          context.go('/chats');
        }
      } catch (_) {
        // Ignore invalid responses.
      }
    });

    nostrService.subscribeWithId(
      subid,
      NostrFilter(
        kinds: const [1059],
        pTags: [ephPubkeyHex],
      ),
    );
  }

  Future<void> _copyToClipboard() async {
    final url = _inviteUrl;
    if (url == null) return;
    await Clipboard.setData(ClipboardData(text: url));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Copied to clipboard')),
      );
    }
  }

  Future<void> _share() async {
    final url = _inviteUrl;
    if (url == null) return;
    await Share.share(url, subject: 'Iris Link Device');
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Link Device'),
        actions: [
          IconButton(
            onPressed: _isLoading ? null : _createLinkInvite,
            icon: const Icon(Icons.refresh),
            tooltip: 'New link code',
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'On your main device, open Settings and scan this code.',
              style: theme.textTheme.bodyLarge,
            ),
            const SizedBox(height: 16),
            if (_isLoading)
              const Padding(
                padding: EdgeInsets.all(48),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_error != null)
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: theme.colorScheme.errorContainer,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Text(
                  _error!,
                  style: TextStyle(color: theme.colorScheme.onErrorContainer),
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
              const SizedBox(height: 16),
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
              const SizedBox(height: 24),
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: theme.colorScheme.primaryContainer.withValues(alpha: 77),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Row(
                  children: [
                    Icon(
                      Icons.lock_outline,
                      color: theme.colorScheme.primary,
                    ),
                    const SizedBox(width: 12),
                    const Expanded(
                      child: Text(
                        'This device will not store your main private key.',
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../../../config/providers/invite_provider.dart';

class ScanInviteScreen extends ConsumerStatefulWidget {
  const ScanInviteScreen({super.key});

  @override
  ConsumerState<ScanInviteScreen> createState() => _ScanInviteScreenState();
}

class _ScanInviteScreenState extends ConsumerState<ScanInviteScreen> {
  final _urlController = TextEditingController();
  final _scannerController = MobileScannerController();
  bool _isProcessing = false;
  bool _showPasteInput = false;

  @override
  void dispose() {
    _urlController.dispose();
    _scannerController.dispose();
    super.dispose();
  }

  Future<void> _processInvite(String url) async {
    if (_isProcessing) return;

    setState(() => _isProcessing = true);

    try {
      final sessionId =
          await ref.read(inviteStateProvider.notifier).acceptInviteFromUrl(url);

      if (sessionId != null && mounted) {
        // Navigate to the new chat
        context.go('/chats/$sessionId');
      } else if (mounted) {
        final error = ref.read(inviteStateProvider).error;
        _showError(error ?? 'Failed to accept invite');
      }
    } finally {
      if (mounted) {
        setState(() => _isProcessing = false);
      }
    }
  }

  void _showError(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: Theme.of(context).colorScheme.error,
      ),
    );
  }

  void _onDetect(BarcodeCapture capture) {
    if (_isProcessing) return;

    for (final barcode in capture.barcodes) {
      final value = barcode.rawValue;
      if (value != null && _isValidInviteUrl(value)) {
        _scannerController.stop();
        _processInvite(value);
        return;
      }
    }
  }

  bool _isValidInviteUrl(String url) {
    // Check if it looks like an invite URL
    return url.contains('iris.to') || url.contains('/invite/');
  }

  Future<void> _pasteFromClipboard() async {
    final data = await Clipboard.getData('text/plain');
    if (data?.text != null) {
      _urlController.text = data!.text!;
    }
  }

  @override
  Widget build(BuildContext context) {
    final inviteState = ref.watch(inviteStateProvider);
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Scan Invite'),
        actions: [
          TextButton(
            onPressed: () => setState(() => _showPasteInput = !_showPasteInput),
            child: Text(_showPasteInput ? 'Scan' : 'Paste'),
          ),
        ],
      ),
      body: Column(
        children: [
          // Scanner or paste input
          Expanded(
            child: _showPasteInput
                ? _buildPasteInput(theme)
                : _buildScanner(theme),
          ),

          // Processing indicator
          if (_isProcessing || inviteState.isAccepting)
            Container(
              padding: const EdgeInsets.all(16),
              child: const Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                  SizedBox(width: 12),
                  Text('Accepting invite...'),
                ],
              ),
            ),

          // Instructions
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Text(
                _showPasteInput
                    ? 'Paste an invite link to start a conversation'
                    : 'Scan a QR code to start a conversation',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                textAlign: TextAlign.center,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildScanner(ThemeData theme) {
    return Stack(
      children: [
        MobileScanner(
          controller: _scannerController,
          onDetect: _onDetect,
        ),
        // Overlay with cutout
        CustomPaint(
          painter: _ScannerOverlayPainter(
            borderColor: theme.colorScheme.primary,
          ),
          child: const SizedBox.expand(),
        ),
      ],
    );
  }

  Widget _buildPasteInput(ThemeData theme) {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          TextField(
            controller: _urlController,
            decoration: InputDecoration(
              labelText: 'Invite Link',
              hintText: 'https://iris.to/invite/...',
              border: const OutlineInputBorder(),
              suffixIcon: IconButton(
                icon: const Icon(Icons.paste),
                onPressed: _pasteFromClipboard,
                tooltip: 'Paste from clipboard',
              ),
            ),
            maxLines: 3,
            autocorrect: false,
          ),
          const SizedBox(height: 24),
          FilledButton.icon(
            onPressed: _isProcessing
                ? null
                : () {
                    final url = _urlController.text.trim();
                    if (url.isNotEmpty) {
                      _processInvite(url);
                    }
                  },
            icon: const Icon(Icons.check),
            label: const Text('Accept Invite'),
          ),
        ],
      ),
    );
  }
}

class _ScannerOverlayPainter extends CustomPainter {
  _ScannerOverlayPainter({required this.borderColor});

  final Color borderColor;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = Colors.black54
      ..style = PaintingStyle.fill;

    final cutoutSize = size.width * 0.7;
    final cutoutLeft = (size.width - cutoutSize) / 2;
    final cutoutTop = (size.height - cutoutSize) / 2;
    final cutoutRect = Rect.fromLTWH(cutoutLeft, cutoutTop, cutoutSize, cutoutSize);

    // Draw overlay with hole
    final path = Path()
      ..addRect(Rect.fromLTWH(0, 0, size.width, size.height))
      ..addRRect(RRect.fromRectAndRadius(cutoutRect, const Radius.circular(16)))
      ..fillType = PathFillType.evenOdd;

    canvas.drawPath(path, paint);

    // Draw border
    final borderPaint = Paint()
      ..color = borderColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3;

    canvas.drawRRect(
      RRect.fromRectAndRadius(cutoutRect, const Radius.circular(16)),
      borderPaint,
    );

    // Draw corner accents
    final accentPaint = Paint()
      ..color = borderColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = 5
      ..strokeCap = StrokeCap.round;

    const cornerLength = 30.0;
    final corners = [
      // Top left
      [Offset(cutoutLeft, cutoutTop + cornerLength), Offset(cutoutLeft, cutoutTop), Offset(cutoutLeft + cornerLength, cutoutTop)],
      // Top right
      [Offset(cutoutLeft + cutoutSize - cornerLength, cutoutTop), Offset(cutoutLeft + cutoutSize, cutoutTop), Offset(cutoutLeft + cutoutSize, cutoutTop + cornerLength)],
      // Bottom left
      [Offset(cutoutLeft, cutoutTop + cutoutSize - cornerLength), Offset(cutoutLeft, cutoutTop + cutoutSize), Offset(cutoutLeft + cornerLength, cutoutTop + cutoutSize)],
      // Bottom right
      [Offset(cutoutLeft + cutoutSize - cornerLength, cutoutTop + cutoutSize), Offset(cutoutLeft + cutoutSize, cutoutTop + cutoutSize), Offset(cutoutLeft + cutoutSize, cutoutTop + cutoutSize - cornerLength)],
    ];

    for (final corner in corners) {
      canvas.drawLine(corner[0], corner[1], accentPaint);
      canvas.drawLine(corner[1], corner[2], accentPaint);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

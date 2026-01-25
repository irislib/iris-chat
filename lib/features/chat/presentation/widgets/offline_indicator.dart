import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../config/providers/connectivity_provider.dart';
import '../../../../core/services/connectivity_service.dart';

/// A banner that shows when the device is offline.
class OfflineBanner extends ConsumerWidget {
  const OfflineBanner({super.key});

  static const _bannerPadding = EdgeInsets.symmetric(vertical: 8, horizontal: 16);
  static const _offlineIcon = Icon(Icons.cloud_off, color: Colors.white, size: 16);
  static const _spacing = SizedBox(width: 8);
  static const _offlineText = Text(
    'You are offline. Messages will be sent when connected.',
    style: TextStyle(color: Colors.white, fontSize: 12),
    textAlign: TextAlign.center,
  );
  static const _empty = SizedBox.shrink();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final statusAsync = ref.watch(connectivityStatusProvider);

    return statusAsync.when(
      data: (status) {
        if (status == ConnectivityStatus.online) {
          return _empty;
        }

        return Container(
          width: double.infinity,
          padding: _bannerPadding,
          color: Colors.orange.shade800,
          child: const Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              _offlineIcon,
              _spacing,
              Flexible(child: _offlineText),
              _spacing,
              _QueueIndicator(),
            ],
          ),
        );
      },
      loading: () => _empty,
      error: (_, __) => _empty,
    );
  }
}

class _QueueIndicator extends ConsumerWidget {
  const _QueueIndicator();

  static const _padding = EdgeInsets.symmetric(horizontal: 8, vertical: 2);
  static const _borderRadius = BorderRadius.all(Radius.circular(12));
  static const _textStyle = TextStyle(color: Colors.white, fontSize: 11);
  static const _empty = SizedBox.shrink();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final count = ref.watch(queuedMessageCountProvider);

    if (count == 0) return _empty;

    return Container(
      padding: _padding,
      decoration: BoxDecoration(
        color: Colors.white.withOpacity(0.2),
        borderRadius: _borderRadius,
      ),
      child: Text(
        '$count queued',
        style: _textStyle,
      ),
    );
  }
}

/// An icon that shows connection status.
class ConnectionStatusIcon extends ConsumerWidget {
  const ConnectionStatusIcon({super.key, this.size = 16});

  final double size;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final statusAsync = ref.watch(connectivityStatusProvider);

    return statusAsync.when(
      data: _buildIcon,
      loading: () => Icon(
        Icons.cloud_queue,
        size: size,
        color: Colors.grey,
      ),
      error: (_, __) => Icon(
        Icons.cloud_off,
        size: size,
        color: Colors.red,
      ),
    );
  }

  Widget _buildIcon(ConnectivityStatus status) {
    switch (status) {
      case ConnectivityStatus.online:
        return Icon(
          Icons.cloud_done,
          size: size,
          color: Colors.green,
        );
      case ConnectivityStatus.offline:
        return Icon(
          Icons.cloud_off,
          size: size,
          color: Colors.orange,
        );
      case ConnectivityStatus.unknown:
        return Icon(
          Icons.cloud_queue,
          size: size,
          color: Colors.grey,
        );
    }
  }
}

/// A wrapper that shows an offline banner above the child.
class OfflineAwareScaffold extends StatelessWidget {
  const OfflineAwareScaffold({
    super.key,
    required this.body,
    this.appBar,
    this.floatingActionButton,
    this.bottomNavigationBar,
  });

  final Widget body;
  final PreferredSizeWidget? appBar;
  final Widget? floatingActionButton;
  final Widget? bottomNavigationBar;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: appBar,
      body: Column(
        children: [
          const OfflineBanner(),
          Expanded(child: body),
        ],
      ),
      floatingActionButton: floatingActionButton,
      bottomNavigationBar: bottomNavigationBar,
    );
  }
}

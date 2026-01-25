import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/services/connectivity_service.dart';
import '../../core/services/offline_queue_service.dart';
import 'chat_provider.dart';

/// Provider for connectivity service.
final connectivityServiceProvider = Provider<ConnectivityService>((ref) {
  final service = ConnectivityService();

  // Start monitoring
  service.startMonitoring();

  // Dispose on provider disposal
  ref.onDispose(service.dispose);

  return service;
});

/// Stream provider for connectivity status.
final connectivityStatusProvider = StreamProvider<ConnectivityStatus>((ref) {
  final service = ref.watch(connectivityServiceProvider);
  return service.statusStream;
});

/// Provider for current connectivity status.
final isOnlineProvider = Provider<bool>((ref) {
  final statusAsync = ref.watch(connectivityStatusProvider);
  return statusAsync.maybeWhen(
    data: (status) => status == ConnectivityStatus.online,
    orElse: () => true, // Assume online if unknown
  );
});

/// Provider for offline queue service.
final offlineQueueServiceProvider = Provider<OfflineQueueService>((ref) {
  final connectivityService = ref.watch(connectivityServiceProvider);
  final chatNotifier = ref.read(chatStateProvider.notifier);

  final service = OfflineQueueService(
    connectivityService: connectivityService,
    sendMessage: (queuedMessage) async {
      // Send the message using the chat notifier
      await chatNotifier.sendQueuedMessage(
        queuedMessage.sessionId,
        queuedMessage.text,
        queuedMessage.id,
      );
    },
  );

  // Initialize
  service.initialize();

  // Dispose on provider disposal
  ref.onDispose(service.dispose);

  return service;
});

/// Stream provider for offline queue.
final offlineQueueProvider = StreamProvider<List<QueuedMessage>>((ref) {
  final service = ref.watch(offlineQueueServiceProvider);
  return service.queueStream;
});

/// Provider for queued message count.
final queuedMessageCountProvider = Provider<int>((ref) {
  final queueAsync = ref.watch(offlineQueueProvider);
  return queueAsync.maybeWhen(
    data: (queue) => queue.length,
    orElse: () => 0,
  );
});

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/services/nostr_service.dart';
import '../../features/chat/data/datasources/message_subscription.dart';
import 'chat_provider.dart';
import 'invite_provider.dart';

/// Provider for the Nostr service.
final nostrServiceProvider = Provider<NostrService>((ref) {
  final service = NostrService();

  // Connect on creation
  service.connect();

  // Disconnect on disposal
  ref.onDispose(service.disconnect);

  return service;
});

/// Provider for message subscription.
final messageSubscriptionProvider = Provider<MessageSubscription>((ref) {
  final nostrService = ref.watch(nostrServiceProvider);
  final sessionDatasource = ref.watch(sessionDatasourceProvider);
  final inviteDatasource = ref.watch(inviteDatasourceProvider);

  final subscription = MessageSubscription(
    nostrService,
    sessionDatasource,
    inviteDatasource,
  );

  // Set up message handler
  subscription.onMessage = ref.read(chatStateProvider.notifier).receiveMessage;

  // Set up invite response handler
  subscription.onInviteResponse =
      ref.read(inviteStateProvider.notifier).handleInviteResponse;

  // Start listening
  subscription.startListening();

  // Stop on disposal
  ref.onDispose(subscription.stopListening);

  return subscription;
});

/// Provider for connection status.
final nostrConnectionStatusProvider = StreamProvider<Map<String, bool>>((ref) {
  final nostrService = ref.watch(nostrServiceProvider);

  // Poll connection status every 5 seconds
  return Stream.periodic(
    const Duration(seconds: 5),
    (_) => nostrService.connectionStatus,
  );
});

/// Provider for connected relay count.
final connectedRelayCountProvider = Provider<int>((ref) {
  final nostrService = ref.watch(nostrServiceProvider);
  return nostrService.connectedCount;
});

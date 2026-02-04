import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/services/nostr_service.dart';
import '../../core/services/profile_service.dart';
import '../../core/services/session_manager_service.dart';
import 'auth_provider.dart';
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

/// Provider for session manager service.
final sessionManagerServiceProvider = Provider<SessionManagerService>((ref) {
  final nostrService = ref.watch(nostrServiceProvider);
  final sessionDatasource = ref.watch(sessionDatasourceProvider);
  final authRepository = ref.watch(authRepositoryProvider);

  final service =
      SessionManagerService(nostrService, sessionDatasource, authRepository);

  service.start();

  ref.onDispose(service.dispose);

  return service;
});

/// Provider for message subscription (backwards-compatible alias).
final messageSubscriptionProvider = Provider<SessionManagerService>((ref) {
  final service = ref.watch(sessionManagerServiceProvider);
  final nostrService = ref.watch(nostrServiceProvider);
  final inviteDatasource = ref.watch(inviteDatasourceProvider);

  final sub = service.decryptedMessages.listen((message) {
    ref.read(chatStateProvider.notifier).receiveDecryptedMessage(
          message.senderPubkeyHex,
          message.content,
          eventId: message.eventId,
          createdAt: message.createdAt,
        );
  });

  final inviteSub = nostrService.events.listen((event) async {
    if (event.kind != 1059) return;
    final inviteEphemeralPubkey = event.getTagValue('p');
    if (inviteEphemeralPubkey == null) return;

    final invites = await inviteDatasource.getActiveInvites();
    for (final invite in invites) {
      if (invite.serializedState == null) continue;
      try {
        final state =
            jsonDecode(invite.serializedState!) as Map<String, dynamic>;
        final ephemeralPubkey = state['inviterEphemeralPublicKey'] as String?;
        if (ephemeralPubkey == inviteEphemeralPubkey) {
          ref
              .read(inviteStateProvider.notifier)
              .handleInviteResponse(invite.id, jsonEncode(event.toJson()));
          return;
        }
      } catch (_) {}
    }
  });

  ref.onDispose(sub.cancel);
  ref.onDispose(inviteSub.cancel);

  return service;
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

/// Provider for profile service.
final profileServiceProvider = Provider<ProfileService>((ref) {
  final nostrService = ref.watch(nostrServiceProvider);
  final service = ProfileService(nostrService);
  ref.onDispose(service.dispose);
  return service;
});

import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/ffi/ndr_ffi.dart';
import '../../core/services/nostr_service.dart';
import '../../core/services/profile_service.dart';
import '../../core/services/session_manager_service.dart';
import '../../core/utils/invite_url.dart';
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

  final service = SessionManagerService(
    nostrService,
    sessionDatasource,
    authRepository,
  );

  service.start();

  ref.onDispose(service.dispose);

  return service;
});

/// Provider for message subscription (backwards-compatible alias).
final messageSubscriptionProvider = Provider<SessionManagerService>((ref) {
  final service = ref.watch(sessionManagerServiceProvider);
  final nostrService = ref.watch(nostrServiceProvider);
  final inviteDatasource = ref.watch(inviteDatasourceProvider);

  const inviteResponsesSubId = 'app-invite-responses';

  // Serialize all processing in this provider to reduce SQLite "database locked"
  // warnings caused by concurrent async stream handlers.
  Future<void> serial = Future.value();
  void schedule(Future<void> Function() task) {
    serial = serial.then((_) => task()).catchError((_, __) {});
  }

  Future<String?> resolveInviteEphemeralPubkey(String serializedState) async {
    // Best-effort extract from stored JSON first.
    try {
      final decoded = jsonDecode(serializedState);
      if (decoded is Map<String, dynamic>) {
        final candidates = <Object?>[
          decoded['ephemeralKey'],
          decoded['inviterEphemeralPublicKey'],
          decoded['inviterEphemeralPublicKeyHex'],
          decoded['inviterEphemeralPubkeyHex'],
          decoded['inviter_ephemeral_public_key'],
          decoded['inviter_ephemeral_public_key_hex'],
          decoded['inviter_ephemeral_pubkey_hex'],
        ];
        for (final c in candidates) {
          if (c is String && c.isNotEmpty) return c;
        }
      }
    } catch (_) {}

    // Fallback: roundtrip through native invite -> URL and read fragment.
    InviteHandle? handle;
    try {
      handle = await NdrFfi.inviteDeserialize(serializedState);
      final url = await handle.toUrl('https://iris.to');
      final data = decodeInviteUrlData(url);
      final eph =
          data?['ephemeralKey'] ??
          data?['inviterEphemeralPublicKey'] ??
          data?['inviterEphemeralPublicKeyHex'] ??
          data?['inviterEphemeralPubkeyHex'] ??
          data?['inviter_ephemeral_public_key'] ??
          data?['inviter_ephemeral_public_key_hex'] ??
          data?['inviter_ephemeral_pubkey_hex'];
      if (eph is String && eph.isNotEmpty) return eph;
    } catch (_) {
      // Ignore; invite state may be malformed or native may be unavailable.
    } finally {
      try {
        await handle?.dispose();
      } catch (_) {}
    }
    return null;
  }

  Future<void> refreshInviteResponseSubscription() async {
    final invites = await inviteDatasource.getActiveInvites();
    final ephs = <String>{};

    for (final invite in invites) {
      final serialized = invite.serializedState;
      if (serialized == null || serialized.isEmpty) continue;
      final eph = await resolveInviteEphemeralPubkey(serialized);
      if (eph != null && eph.isNotEmpty) ephs.add(eph);
    }

    if (ephs.isEmpty) {
      nostrService.closeSubscription(inviteResponsesSubId);
      return;
    }

    nostrService.subscribeWithIdRaw(inviteResponsesSubId, <String, dynamic>{
      'kinds': const [1059],
      '#p': ephs.toList(),
    });
  }

  // Subscribe for invite responses (and refresh when invites change).
  schedule(refreshInviteResponseSubscription);
  ref.listen<InviteState>(inviteStateProvider, (_, __) {
    schedule(refreshInviteResponseSubscription);
  });
  ref.onDispose(() {
    nostrService.closeSubscription(inviteResponsesSubId);
  });

  final sub = service.decryptedMessages.listen((message) {
    schedule(() async {
      final chatMessage = await ref
          .read(chatStateProvider.notifier)
          .receiveDecryptedMessage(
            message.senderPubkeyHex,
            message.content,
            eventId: message.eventId,
            createdAt: message.createdAt,
          );

      if (chatMessage == null) return;

      final sessionNotifier = ref.read(sessionStateProvider.notifier);
      final session = await sessionNotifier.ensureSessionForRecipient(
        chatMessage.sessionId,
      );

      await sessionNotifier.updateSessionWithMessage(session.id, chatMessage);

      if (chatMessage.isIncoming) {
        await sessionNotifier.incrementUnread(session.id);
      }
    });
  });

  final inviteSub = nostrService.events.listen((event) {
    schedule(() async {
      if (event.kind != 1059) return;
      // Only consider events delivered by our invite-response subscription.
      // Other subscriptions (sessions, app-keys, etc.) can also carry kind 1059.
      if (event.subscriptionId != inviteResponsesSubId) return;
      final pTags = <String>{};
      for (final t in event.tags) {
        if (t.length < 2) continue;
        if (t[0] == 'p') pTags.add(t[1]);
      }
      if (pTags.isEmpty) return;

      final invites = await inviteDatasource.getActiveInvites();
      for (final invite in invites) {
        if (invite.serializedState == null) continue;
        try {
          final serialized = invite.serializedState!;
          final ephemeralPubkey = await resolveInviteEphemeralPubkey(serialized);
          if (ephemeralPubkey == null || ephemeralPubkey.isEmpty) continue;
          if (!pTags.contains(ephemeralPubkey)) continue;

          await ref
              .read(inviteStateProvider.notifier)
              .handleInviteResponse(invite.id, jsonEncode(event.toJson()));
          return;
        } catch (_) {}
      }
    });
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

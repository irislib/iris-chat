import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/ffi/ndr_ffi.dart';
import '../../core/services/nostr_service.dart';
import '../../core/services/profile_service.dart';
import '../../core/services/session_manager_service.dart';
import '../../core/utils/invite_url.dart';
import '../../core/utils/nostr_rumor.dart';
import '../../features/chat/domain/utils/chat_settings.dart';
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
  // Ensure this provider rebuilds when the authenticated identity/device changes
  // (e.g., login, linked-device login, key rotation).
  ref.watch(
    authStateProvider.select(
      (s) => (s.isAuthenticated, s.pubkeyHex, s.devicePubkeyHex),
    ),
  );

  final nostrService = ref.watch(nostrServiceProvider);
  final sessionDatasource = ref.watch(sessionDatasourceProvider);
  final authRepository = ref.watch(authRepositoryProvider);

  final service = SessionManagerService(
    nostrService,
    sessionDatasource,
    authRepository,
  );

  unawaited(service.start().catchError((_, __) {}));

  ref.onDispose(() {
    unawaited(service.dispose().catchError((_, __) {}));
  });

  return service;
});

/// Provider for message subscription (backwards-compatible alias).
final messageSubscriptionProvider = Provider<SessionManagerService>((ref) {
  final service = ref.watch(sessionManagerServiceProvider);
  final nostrService = ref.watch(nostrServiceProvider);
  final inviteDatasource = ref.watch(inviteDatasourceProvider);
  final sessionDatasource = ref.watch(sessionDatasourceProvider);
  final messageDatasource = ref.watch(messageDatasourceProvider);
  final groupDatasource = ref.watch(groupDatasourceProvider);
  final groupMessageDatasource = ref.watch(groupMessageDatasourceProvider);

  const inviteResponsesSubId = 'app-invite-responses';

  // Serialize all processing in this provider to reduce SQLite "database locked"
  // warnings caused by concurrent async stream handlers.
  Future<void> serial = Future.value();
  void schedule(Future<void> Function() task) {
    serial = serial.then((_) => task()).catchError((_, __) {});
  }

  Timer? expirationTimer;

  void scheduleExpirationTick(Duration delay) {
    expirationTimer?.cancel();
    expirationTimer = Timer(delay, () {
      schedule(() async {
        final nowSeconds = DateTime.now().millisecondsSinceEpoch ~/ 1000;
        var nextDelayMs = 60000;

        try {
          // Purge expired messages from persistent storage first.
          final affectedSessions = await messageDatasource
              .deleteExpiredMessages(nowSeconds);
          final affectedGroups = await groupMessageDatasource
              .deleteExpiredMessages(nowSeconds);

          // Purge expired messages from in-memory UI stores.
          ref
              .read(chatStateProvider.notifier)
              .purgeExpiredFromState(nowSeconds);
          ref
              .read(groupStateProvider.notifier)
              .purgeExpiredFromState(nowSeconds);

          final sessionNotifier = ref.read(sessionStateProvider.notifier);
          for (final sessionId in affectedSessions) {
            await sessionDatasource.recomputeDerivedFieldsFromMessages(
              sessionId,
            );
            await sessionNotifier.refreshSession(sessionId);
          }

          final groupNotifier = ref.read(groupStateProvider.notifier);
          for (final groupId in affectedGroups) {
            await groupDatasource.recomputeDerivedFieldsFromMessages(groupId);
            await groupNotifier.refreshGroup(groupId);
          }

          // Schedule next tick based on the next soonest expiration.
          final nextDm = await messageDatasource.getNextExpirationSeconds();
          final nextGroup = await groupMessageDatasource
              .getNextExpirationSeconds();

          int? next;
          if (nextDm != null && nextGroup != null) {
            next = nextDm < nextGroup ? nextDm : nextGroup;
          } else {
            next = nextDm ?? nextGroup;
          }

          if (next != null) {
            nextDelayMs = (next - nowSeconds) * 1000;
          }
        } catch (_) {
          // Best-effort; try again later.
        }

        final clampedMs = nextDelayMs < 1000
            ? 1000
            : (nextDelayMs > 60000 ? 60000 : nextDelayMs);
        scheduleExpirationTick(Duration(milliseconds: clampedMs));
      });
    });
  }

  // Start a little after hydration so initial loads don't race the DB.
  scheduleExpirationTick(const Duration(seconds: 2));
  ref.onDispose(() {
    expirationTimer?.cancel();
    expirationTimer = null;
  });

  // Coalesce refresh work so repeated invite state changes don't build up an
  // unbounded Future chain (which can lead to runaway memory usage).
  var refreshScheduled = false;
  var refreshAgain = false;

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
  void requestInviteResponseSubscriptionRefresh() {
    if (refreshScheduled) {
      refreshAgain = true;
      return;
    }
    refreshScheduled = true;
    schedule(() async {
      try {
        while (true) {
          refreshAgain = false;
          await refreshInviteResponseSubscription();
          if (!refreshAgain) break;
        }
      } finally {
        refreshScheduled = false;
      }
    });
  }

  requestInviteResponseSubscriptionRefresh();
  ref.listen<InviteState>(inviteStateProvider, (_, __) {
    requestInviteResponseSubscriptionRefresh();
  });
  ref.onDispose(() {
    nostrService.closeSubscription(inviteResponsesSubId);
  });

  final sub = service.decryptedMessages.listen((message) {
    schedule(() async {
      final rumor = NostrRumor.tryParse(message.content);
      if (rumor != null) {
        final groupId = getFirstTagValue(rumor.tags, 'l');
        if (groupId != null || rumor.kind == 40) {
          await ref
              .read(groupStateProvider.notifier)
              .handleIncomingGroupRumorJson(
                message.content,
                eventId: message.eventId,
              );
          return;
        }

        if (rumor.kind == kChatSettingsKind) {
          final settings = parseChatSettingsContent(rumor.content);
          if (settings == null) return;

          final owner = service.ownerPubkeyHex;
          final peer = owner != null
              ? resolveRumorPeerPubkey(ownerPubkeyHex: owner, rumor: rumor)
              : message.senderPubkeyHex;
          if (peer == null || peer.isEmpty) return;

          final sessionNotifier = ref.read(sessionStateProvider.notifier);
          final session = await sessionNotifier.ensureSessionForRecipient(peer);
          await sessionNotifier.setMessageTtlSeconds(
            session.id,
            settings.messageTtlSeconds,
          );
          return;
        }
      }

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
    // Filter before scheduling: relays can deliver a high volume of events and
    // queueing no-op tasks here can explode memory if the DB stalls.
    if (event.kind != 1059) return;
    // Only consider events delivered by our invite-response subscription.
    // Other subscriptions (sessions, app-keys, etc.) can also carry kind 1059.
    if (event.subscriptionId != inviteResponsesSubId) return;

    schedule(() async {
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
          final ephemeralPubkey = await resolveInviteEphemeralPubkey(
            serialized,
          );
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

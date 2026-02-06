import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:freezed_annotation/freezed_annotation.dart';
import 'package:uuid/uuid.dart';

import '../../core/ffi/ndr_ffi.dart';
import '../../core/services/logger_service.dart';
import '../../core/services/nostr_service.dart';
import '../../core/utils/invite_url.dart';
import '../../features/chat/domain/models/session.dart';
import '../../features/invite/data/datasources/invite_local_datasource.dart';
import '../../features/invite/domain/models/invite.dart';
import 'auth_provider.dart';
import 'chat_provider.dart';
import 'nostr_provider.dart';

part 'invite_provider.freezed.dart';

/// State for invites.
@freezed
abstract class InviteState with _$InviteState {
  const factory InviteState({
    @Default([]) List<Invite> invites,
    @Default(false) bool isLoading,
    @Default(false) bool isCreating,
    @Default(false) bool isAccepting,
    String? error,
  }) = _InviteState;
}

/// Notifier for invite state.
class InviteNotifier extends StateNotifier<InviteState> {
  InviteNotifier(this._datasource, this._ref) : super(const InviteState());

  final InviteLocalDatasource _datasource;
  final Ref _ref;

  /// Load all invites from storage.
  Future<void> loadInvites() async {
    state = state.copyWith(isLoading: true, error: null);
    try {
      final invites = await _datasource.getActiveInvites();
      state = state.copyWith(invites: invites, isLoading: false);
    } catch (e) {
      state = state.copyWith(isLoading: false, error: e.toString());
    }
  }

  /// Create a new invite.
  Future<Invite?> createInvite({String? label, int? maxUses}) async {
    state = state.copyWith(isCreating: true, error: null);
    InviteHandle? inviteHandle;
    try {
      final authState = _ref.read(authStateProvider);
      if (!authState.isAuthenticated || authState.pubkeyHex == null) {
        throw Exception('Not authenticated');
      }

      // Use the device identity key to create invites so linked devices can participate.
      final authRepo = _ref.read(authRepositoryProvider);
      final devicePrivkeyHex = await authRepo.getPrivateKey();
      if (devicePrivkeyHex == null) {
        throw Exception('Private key not found');
      }
      final devicePubkeyHex = await NdrFfi.derivePublicKey(devicePrivkeyHex);

      // Default to single-use chat invites to avoid replay/duplicate session creation.
      final effectiveMaxUses = maxUses ?? 1;

      // Create invite using ndr-ffi
      inviteHandle = await NdrFfi.createInvite(
        inviterPubkeyHex: devicePubkeyHex,
        deviceId: devicePubkeyHex,
        maxUses: effectiveMaxUses,
      );

      // Make purpose explicit for cross-client compatibility.
      await inviteHandle.setPurpose('chat');

      // Embed owner pubkey in invite URLs for multi-device mapping.
      await inviteHandle.setOwnerPubkeyHex(authState.pubkeyHex);

      // Serialize for storage
      final serializedState = await inviteHandle.serialize();
      final inviterPubkey = await inviteHandle.getInviterPubkeyHex();

      final invite = Invite(
        id: const Uuid().v4(),
        inviterPubkeyHex: inviterPubkey,
        label: label,
        createdAt: DateTime.now(),
        maxUses: effectiveMaxUses,
        serializedState: serializedState,
      );

      await _datasource.saveInvite(invite);

      state = state.copyWith(
        invites: [invite, ...state.invites],
        isCreating: false,
      );

      return invite;
    } catch (e) {
      state = state.copyWith(isCreating: false, error: e.toString());
      return null;
    } finally {
      try {
        await inviteHandle?.dispose();
      } catch (_) {}
    }
  }

  /// Accept an invite from a URL.
  Future<String?> acceptInviteFromUrl(String url) async {
    state = state.copyWith(isAccepting: true, error: null);
    InviteHandle? inviteHandle;
    InviteAcceptResult? acceptResult;
    try {
      final authState = _ref.read(authStateProvider);
      if (!authState.isAuthenticated || authState.pubkeyHex == null) {
        throw Exception('Not authenticated');
      }

      // Get private key from storage
      final authRepo = _ref.read(authRepositoryProvider);
      final devicePrivkeyHex = await authRepo.getPrivateKey();
      if (devicePrivkeyHex == null) {
        throw Exception('Private key not found');
      }
      final devicePubkeyHex = await NdrFfi.derivePublicKey(devicePrivkeyHex);
      final ownerPubkeyHex = authState.pubkeyHex!;

      // Parse and accept invite
      inviteHandle = await NdrFfi.inviteFromUrl(url);
      acceptResult = await inviteHandle.acceptWithOwner(
        inviteePubkeyHex: devicePubkeyHex,
        inviteePrivkeyHex: devicePrivkeyHex,
        deviceId: devicePubkeyHex,
        ownerPubkeyHex: ownerPubkeyHex,
      );

      // Get inviter pubkey
      final inviterDevicePubkey = await inviteHandle.getInviterPubkeyHex();
      final inviterOwnerPubkey =
          extractInviteOwnerPubkeyHex(url) ?? inviterDevicePubkey;

      // Serialize session state
      final sessionState = await acceptResult.session.stateJson();

      // Store sessions keyed by peer owner pubkey for stable routing/deduping.
      final sessionDatasource = _ref.read(sessionDatasourceProvider);
      final existing = await sessionDatasource.getSessionByRecipient(
        inviterOwnerPubkey,
      );
      final sessionId = existing?.id ?? inviterOwnerPubkey;

      // Create session in chat provider
      final sessionNotifier = _ref.read(sessionStateProvider.notifier);
      final session = ChatSession(
        id: sessionId,
        recipientPubkeyHex: inviterOwnerPubkey,
        recipientName: existing?.recipientName,
        createdAt: existing?.createdAt ?? DateTime.now(),
        lastMessageAt: existing?.lastMessageAt,
        lastMessagePreview: existing?.lastMessagePreview,
        unreadCount: existing?.unreadCount ?? 0,
        inviteId: existing?.inviteId,
        isInitiator: existing?.isInitiator ?? false,
        serializedState: sessionState,
      );

      await sessionNotifier.addSession(session);

      // Import session into the session manager (so it can subscribe/decrypt)
      final sessionManager = _ref.read(sessionManagerServiceProvider);
      await sessionManager.importSessionState(
        peerPubkeyHex: inviterOwnerPubkey,
        stateJson: sessionState,
        deviceId: inviterDevicePubkey,
      );

      // Publish response event to Nostr relays
      final nostrService = _ref.read(nostrServiceProvider);
      await nostrService.publishEvent(acceptResult.responseEventJson);

      // Refresh subscription to listen for messages from the new session
      await sessionManager.refreshSubscription();

      state = state.copyWith(isAccepting: false);
      return sessionId;
    } catch (e) {
      state = state.copyWith(isAccepting: false, error: e.toString());
      return null;
    } finally {
      try {
        await acceptResult?.session.dispose();
      } catch (_) {}
      try {
        await inviteHandle?.dispose();
      } catch (_) {}
    }
  }

  /// Accept a private link invite as the owner and register the new device in AppKeys.
  ///
  /// Returns true on success.
  Future<bool> acceptLinkInviteFromUrl(String url) async {
    state = state.copyWith(isAccepting: true, error: null);
    InviteHandle? inviteHandle;
    InviteAcceptResult? acceptResult;
    try {
      final authState = _ref.read(authStateProvider);
      if (!authState.isAuthenticated || authState.pubkeyHex == null) {
        throw Exception('Not authenticated');
      }
      if (authState.isLinkedDevice) {
        throw Exception('Linked devices cannot accept link invites');
      }

      final authRepo = _ref.read(authRepositoryProvider);
      final ownerPrivkeyHex = await authRepo.getPrivateKey();
      if (ownerPrivkeyHex == null) {
        throw Exception('Private key not found');
      }

      final ownerPubkeyHex = authState.pubkeyHex!;
      final devicePubkeyHex = await NdrFfi.derivePublicKey(ownerPrivkeyHex);

      inviteHandle = await NdrFfi.inviteFromUrl(url);
      acceptResult = await inviteHandle.acceptWithOwner(
        inviteePubkeyHex: devicePubkeyHex,
        inviteePrivkeyHex: ownerPrivkeyHex,
        deviceId: devicePubkeyHex,
        ownerPubkeyHex: ownerPubkeyHex,
      );

      final linkedDevicePubkeyHex = await inviteHandle.getInviterPubkeyHex();

      // Publish response event so the linking device can complete the flow.
      final nostrService = _ref.read(nostrServiceProvider);
      await nostrService.publishEvent(acceptResult.responseEventJson);

      // Publish updated AppKeys authorizing the new device.
      await _publishMergedAppKeys(
        ownerPubkeyHex: ownerPubkeyHex,
        ownerPrivkeyHex: ownerPrivkeyHex,
        devicePubkeysToEnsure: {devicePubkeyHex, linkedDevicePubkeyHex},
      );

      // Best-effort refresh so the local SessionManager can learn about the new device quickly.
      await _ref.read(sessionManagerServiceProvider).refreshSubscription();

      state = state.copyWith(isAccepting: false);
      return true;
    } catch (e) {
      state = state.copyWith(isAccepting: false, error: e.toString());
      return false;
    } finally {
      // We don't need the temporary link session/handle beyond the response + AppKeys publish.
      try {
        await acceptResult?.session.dispose();
      } catch (_) {}
      try {
        await inviteHandle?.dispose();
      } catch (_) {}
    }
  }

  /// Get the URL for an invite.
  Future<String?> getInviteUrl(
    String inviteId, {
    String root = 'https://iris.to',
  }) async {
    InviteHandle? inviteHandle;
    try {
      final invite = await _datasource.getInvite(inviteId);
      if (invite?.serializedState == null) return null;

      inviteHandle = await NdrFfi.inviteDeserialize(
        invite!.serializedState!,
      );
      return await inviteHandle.toUrl(root);
    } catch (e) {
      state = state.copyWith(error: e.toString());
      return null;
    } finally {
      try {
        await inviteHandle?.dispose();
      } catch (_) {}
    }
  }

  /// Delete an invite.
  Future<void> deleteInvite(String id) async {
    await _datasource.deleteInvite(id);
    state = state.copyWith(
      invites: state.invites.where((i) => i.id != id).toList(),
    );
  }

  /// Update invite label.
  Future<void> updateLabel(String id, String label) async {
    final invite = state.invites.firstWhere((i) => i.id == id);
    final updated = invite.copyWith(label: label);
    await _datasource.updateInvite(updated);

    state = state.copyWith(
      invites: state.invites.map((i) => i.id == id ? updated : i).toList(),
    );
  }

  /// Handle an invite response event from Nostr.
  Future<void> handleInviteResponse(String inviteId, String eventJson) async {
    Logger.info(
      'Processing invite response',
      category: LogCategory.nostr,
      data: {'inviteId': inviteId},
    );

    InviteHandle? inviteHandle;
    InviteResponseResult? result;
    try {
      final invite = await _datasource.getInvite(inviteId);
      if (invite?.serializedState == null) {
        Logger.warning(
          'Invite not found for response',
          category: LogCategory.nostr,
          data: {'inviteId': inviteId},
        );
        return;
      }

      final authState = _ref.read(authStateProvider);
      if (!authState.isAuthenticated) {
        throw Exception('Not authenticated');
      }

      // Get private key from storage
      final authRepo = _ref.read(authRepositoryProvider);
      final devicePrivkeyHex = await authRepo.getPrivateKey();
      if (devicePrivkeyHex == null) {
        throw Exception('Private key not found');
      }

      // Process invite response
      inviteHandle = await NdrFfi.inviteDeserialize(
        invite!.serializedState!,
      );
      result = await inviteHandle.processResponse(
        eventJson: eventJson,
        inviterPrivkeyHex: devicePrivkeyHex,
      );

      if (result == null) {
        Logger.warning(
          'Invite response processing returned null',
          category: LogCategory.nostr,
          data: {'inviteId': inviteId},
        );
        return;
      }

      final recipientOwnerPubkey =
          result.ownerPubkeyHex ?? result.inviteePubkeyHex;

      // Serialize session state
      final sessionState = await result.session.stateJson();

      // If we already have a session with this peer, treat this as a replay/duplicate.
      // (Relays can replay stored events on reconnect; multiple relays can send duplicates.)
      final sessionDatasource = _ref.read(sessionDatasourceProvider);
      final existingSession = await sessionDatasource.getSessionByRecipient(
        recipientOwnerPubkey,
      );

      final sessionManager = _ref.read(sessionManagerServiceProvider);

      if (existingSession == null) {
        // Store sessions keyed by peer owner pubkey for stable routing/deduping.
        final sessionId = recipientOwnerPubkey;

        // Create session in chat provider
        final sessionNotifier = _ref.read(sessionStateProvider.notifier);
        final session = ChatSession(
          id: sessionId,
          recipientPubkeyHex: recipientOwnerPubkey,
          createdAt: DateTime.now(),
          inviteId: inviteId,
          isInitiator: true,
          serializedState: sessionState,
        );

        await sessionNotifier.addSession(session);

        // Import session into the session manager (so it can subscribe/decrypt)
        await sessionManager.importSessionState(
          peerPubkeyHex: recipientOwnerPubkey,
          stateJson: sessionState,
          deviceId: result.inviteePubkeyHex,
        );
      } else {
        // Best-effort: ensure the session manager is aware of the (possibly new) peer device id,
        // without overwriting our existing ratchet state.
        final existingState = existingSession.serializedState;
        if (existingState != null && existingState.isNotEmpty) {
          await sessionManager.importSessionState(
            peerPubkeyHex: recipientOwnerPubkey,
            stateJson: existingState,
            deviceId: result.inviteePubkeyHex,
          );
        }
      }

      // Mark invite as used
      await _datasource.markUsed(inviteId, recipientOwnerPubkey);

      // Update local state (only if this is a new acceptance for this invite).
      if (!invite.acceptedBy.contains(recipientOwnerPubkey)) {
        final updatedInvite = invite.copyWith(
          useCount: invite.useCount + 1,
          acceptedBy: [...invite.acceptedBy, recipientOwnerPubkey],
        );
        state = state.copyWith(
          invites: state.invites
              .map((i) => i.id == inviteId ? updatedInvite : i)
              .where((i) => i.canBeUsed)
              .toList(),
        );
      }

      // Refresh message subscription to include new session
      await sessionManager.refreshSubscription();

      Logger.info(
        'Invite response processed, session ready',
        category: LogCategory.nostr,
        data: {
          'inviteId': inviteId,
          'invitee': recipientOwnerPubkey.substring(0, 8),
        },
      );
    } catch (e) {
      Logger.error(
        'Failed to process invite response',
        category: LogCategory.nostr,
        error: e,
        data: {'inviteId': inviteId},
      );
      state = state.copyWith(error: e.toString());
    } finally {
      try {
        await result?.session.dispose();
      } catch (_) {}
      try {
        await inviteHandle?.dispose();
      } catch (_) {}
    }
  }

  /// Clear error state.
  void clearError() {
    state = state.copyWith(error: null);
  }

  Future<void> _publishMergedAppKeys({
    required String ownerPubkeyHex,
    required String ownerPrivkeyHex,
    required Set<String> devicePubkeysToEnsure,
  }) async {
    final nostrService = _ref.read(nostrServiceProvider);

    final existing = await _fetchLatestAppKeysEvent(
      nostrService,
      ownerPubkeyHex: ownerPubkeyHex,
    );

    final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final Map<String, int> devices = {};

    if (existing != null) {
      final parsed = await NdrFfi.parseAppKeysEvent(
        jsonEncode(existing.toJson()),
      );
      for (final entry in parsed) {
        devices[entry.identityPubkeyHex] = entry.createdAt;
      }
    }

    for (final pk in devicePubkeysToEnsure) {
      devices.putIfAbsent(pk, () => now);
    }

    final eventJson = await NdrFfi.createSignedAppKeysEvent(
      ownerPubkeyHex: ownerPubkeyHex,
      ownerPrivkeyHex: ownerPrivkeyHex,
      devices: devices.entries
          .map(
            (e) => FfiDeviceEntry(identityPubkeyHex: e.key, createdAt: e.value),
          )
          .toList(),
    );

    await nostrService.publishEvent(eventJson);
  }

  Future<NostrEvent?> _fetchLatestAppKeysEvent(
    NostrService nostrService, {
    required String ownerPubkeyHex,
    Duration timeout = const Duration(seconds: 2),
  }) async {
    final subid = 'appkeys-fetch-${DateTime.now().microsecondsSinceEpoch}';

    NostrEvent? best;
    final sub = nostrService.events.listen((event) {
      if (event.subscriptionId != subid) return;
      if (event.kind != 30078) return;
      if (event.pubkey != ownerPubkeyHex) return;
      final d = event.getTagValue('d');
      if (d != 'double-ratchet/app-keys') return;

      if (best == null || event.createdAt > best!.createdAt) {
        best = event;
      }
    });

    try {
      nostrService.subscribeWithId(
        subid,
        NostrFilter(kinds: const [30078], authors: [ownerPubkeyHex], limit: 50),
      );

      await Future.delayed(timeout);
      return best;
    } finally {
      await sub.cancel();
      nostrService.closeSubscription(subid);
    }
  }
}

// Provider

final inviteDatasourceProvider = Provider<InviteLocalDatasource>((ref) {
  final db = ref.watch(databaseServiceProvider);
  return InviteLocalDatasource(db);
});

final inviteStateProvider = StateNotifierProvider<InviteNotifier, InviteState>((
  ref,
) {
  final datasource = ref.watch(inviteDatasourceProvider);
  return InviteNotifier(datasource, ref);
});

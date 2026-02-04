import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:freezed_annotation/freezed_annotation.dart';
import 'package:uuid/uuid.dart';

import '../../core/ffi/ndr_ffi.dart';
import '../../core/services/logger_service.dart';
import '../../features/chat/domain/models/session.dart';
import '../../features/invite/data/datasources/invite_local_datasource.dart';
import '../../features/invite/domain/models/invite.dart';
import 'auth_provider.dart';
import 'chat_provider.dart';
import 'nostr_provider.dart';

part 'invite_provider.freezed.dart';

/// State for invites.
@freezed
class InviteState with _$InviteState {
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
    try {
      final authState = _ref.read(authStateProvider);
      if (!authState.isAuthenticated || authState.pubkeyHex == null) {
        throw Exception('Not authenticated');
      }

      // Create invite using ndr-ffi
      final inviteHandle = await NdrFfi.createInvite(
        inviterPubkeyHex: authState.pubkeyHex!,
        maxUses: maxUses,
      );

      // Serialize for storage
      final serializedState = await inviteHandle.serialize();
      final inviterPubkey = await inviteHandle.getInviterPubkeyHex();

      final invite = Invite(
        id: const Uuid().v4(),
        inviterPubkeyHex: inviterPubkey,
        label: label,
        createdAt: DateTime.now(),
        maxUses: maxUses,
        serializedState: serializedState,
      );

      await _datasource.saveInvite(invite);

      state = state.copyWith(
        invites: [invite, ...state.invites],
        isCreating: false,
      );

      // Refresh subscription to listen for responses to the new invite
      await _ref.read(messageSubscriptionProvider).refreshSubscription();

      return invite;
    } catch (e) {
      state = state.copyWith(isCreating: false, error: e.toString());
      return null;
    }
  }

  /// Accept an invite from a URL.
  Future<String?> acceptInviteFromUrl(String url) async {
    state = state.copyWith(isAccepting: true, error: null);
    try {
      final authState = _ref.read(authStateProvider);
      if (!authState.isAuthenticated || authState.pubkeyHex == null) {
        throw Exception('Not authenticated');
      }

      // Get private key from storage
      final authRepo = _ref.read(authRepositoryProvider);
      final privkeyHex = await authRepo.getPrivateKey();
      if (privkeyHex == null) {
        throw Exception('Private key not found');
      }

      // Parse and accept invite
      final inviteHandle = await NdrFfi.inviteFromUrl(url);
      final acceptResult = await inviteHandle.accept(
        inviteePubkeyHex: authState.pubkeyHex!,
        inviteePrivkeyHex: privkeyHex,
      );

      // Get inviter pubkey
      final inviterPubkey = await inviteHandle.getInviterPubkeyHex();

      // Serialize session state
      final sessionState = await acceptResult.session.stateJson();

      // Create session in chat provider
      final sessionNotifier = _ref.read(sessionStateProvider.notifier);
      final session = ChatSession(
        id: acceptResult.session.id,
        recipientPubkeyHex: inviterPubkey,
        createdAt: DateTime.now(),
        isInitiator: false,
        serializedState: sessionState,
      );

      await sessionNotifier.addSession(session);

      // Import session into the session manager (so it can subscribe/decrypt)
      final sessionManager = _ref.read(sessionManagerServiceProvider);
      await sessionManager.importSessionState(
        peerPubkeyHex: inviterPubkey,
        stateJson: sessionState,
      );

      // Publish response event to Nostr relays
      final nostrService = _ref.read(nostrServiceProvider);
      await nostrService.publishEvent(acceptResult.responseEventJson);

      // Refresh subscription to listen for messages from the new session
      await sessionManager.refreshSubscription();

      state = state.copyWith(isAccepting: false);
      return session.id;
    } catch (e) {
      state = state.copyWith(isAccepting: false, error: e.toString());
      return null;
    }
  }

  /// Get the URL for an invite.
  Future<String?> getInviteUrl(
    String inviteId, {
    String root = 'https://iris.to',
  }) async {
    try {
      final invite = await _datasource.getInvite(inviteId);
      if (invite?.serializedState == null) return null;

      final inviteHandle =
          await NdrFfi.inviteDeserialize(invite!.serializedState!);
      return inviteHandle.toUrl(root);
    } catch (e) {
      state = state.copyWith(error: e.toString());
      return null;
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
      final privkeyHex = await authRepo.getPrivateKey();
      if (privkeyHex == null) {
        throw Exception('Private key not found');
      }

      // Process invite response
      final inviteHandle =
          await NdrFfi.inviteDeserialize(invite!.serializedState!);
      final result = await inviteHandle.processResponse(
        eventJson: eventJson,
        inviterPrivkeyHex: privkeyHex,
      );

      if (result == null) {
        Logger.warning(
          'Invite response processing returned null',
          category: LogCategory.nostr,
          data: {'inviteId': inviteId},
        );
        return;
      }

      // Serialize session state
      final sessionState = await result.session.stateJson();

      // Create session in chat provider
      final sessionNotifier = _ref.read(sessionStateProvider.notifier);
      final session = ChatSession(
        id: result.session.id,
        recipientPubkeyHex: result.inviteePubkeyHex,
        recipientName: invite.label,
        createdAt: DateTime.now(),
        isInitiator: true,
        serializedState: sessionState,
      );

      await sessionNotifier.addSession(session);

      // Import session into the session manager (so it can subscribe/decrypt)
      final sessionManager = _ref.read(sessionManagerServiceProvider);
      await sessionManager.importSessionState(
        peerPubkeyHex: result.inviteePubkeyHex,
        stateJson: sessionState,
        deviceId: result.deviceId,
      );

      // Mark invite as used
      await _datasource.markUsed(inviteId, result.inviteePubkeyHex);

      // Update local state
      final updatedInvite = invite.copyWith(
        useCount: invite.useCount + 1,
        acceptedBy: [...invite.acceptedBy, result.inviteePubkeyHex],
      );
      state = state.copyWith(
        invites:
            state.invites.map((i) => i.id == inviteId ? updatedInvite : i).toList(),
      );

      // Refresh message subscription to include new session
      await sessionManager.refreshSubscription();

      Logger.info(
        'Invite response processed, session created',
        category: LogCategory.nostr,
        data: {
          'inviteId': inviteId,
          'sessionId': session.id,
          'invitee': result.inviteePubkeyHex.substring(0, 8),
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
    }
  }

  /// Clear error state.
  void clearError() {
    state = state.copyWith(error: null);
  }
}

// Provider

final inviteDatasourceProvider = Provider<InviteLocalDatasource>((ref) {
  final db = ref.watch(databaseServiceProvider);
  return InviteLocalDatasource(db);
});

final inviteStateProvider =
    StateNotifierProvider<InviteNotifier, InviteState>((ref) {
  final datasource = ref.watch(inviteDatasourceProvider);
  return InviteNotifier(datasource, ref);
});

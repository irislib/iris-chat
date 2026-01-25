import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:freezed_annotation/freezed_annotation.dart';
import 'package:uuid/uuid.dart';

import '../../core/ffi/ndr_ffi.dart';
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

      // Publish response event to Nostr relays
      final nostrService = _ref.read(nostrServiceProvider);
      await nostrService.publishEvent(acceptResult.responseEventJson);

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

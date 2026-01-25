import 'package:uuid/uuid.dart';

import '../../../../core/ffi/ndr_ffi.dart';
import '../../../../core/services/nostr_service.dart';
import '../../domain/models/invite.dart';
import '../../domain/repositories/invite_repository.dart';
import '../datasources/invite_local_datasource.dart';

/// Implementation of [InviteRepository].
class InviteRepositoryImpl implements InviteRepository {
  InviteRepositoryImpl({
    required InviteLocalDatasource datasource,
    required NostrService nostrService,
    required String userPubkeyHex,
    required Future<String?> Function() getPrivateKey,
  })  : _datasource = datasource,
        _nostrService = nostrService,
        _userPubkeyHex = userPubkeyHex,
        _getPrivateKey = getPrivateKey;

  final InviteLocalDatasource _datasource;
  final NostrService _nostrService;
  final String _userPubkeyHex;
  final Future<String?> Function() _getPrivateKey;

  // Cache of active invite handles
  final Map<String, InviteHandle> _inviteHandles = {};

  @override
  Future<Invite> createInvite({String? label, int? maxUses}) async {
    // Create invite using ndr-ffi
    final inviteHandle = await NdrFfi.createInvite(
      inviterPubkeyHex: _userPubkeyHex,
      maxUses: maxUses,
    );

    // Serialize for storage
    final serializedState = await inviteHandle.serialize();
    final inviterPubkey = await inviteHandle.getInviterPubkeyHex();

    final id = const Uuid().v4();
    final invite = Invite(
      id: id,
      inviterPubkeyHex: inviterPubkey,
      label: label,
      createdAt: DateTime.now(),
      maxUses: maxUses,
      serializedState: serializedState,
    );

    // Cache the handle
    _inviteHandles[id] = inviteHandle;

    // Save to storage
    await _datasource.saveInvite(invite);

    return invite;
  }

  @override
  Future<List<Invite>> getAllInvites() async {
    return _datasource.getAllInvites();
  }

  @override
  Future<List<Invite>> getActiveInvites() async {
    return _datasource.getActiveInvites();
  }

  @override
  Future<Invite?> getInvite(String id) async {
    return _datasource.getInvite(id);
  }

  @override
  Future<void> updateInvite(Invite invite) async {
    await _datasource.updateInvite(invite);
  }

  @override
  Future<void> deleteInvite(String id) async {
    // Dispose the handle if cached
    final handle = _inviteHandles.remove(id);
    if (handle != null) {
      await handle.dispose();
    }

    await _datasource.deleteInvite(id);
  }

  @override
  Future<InviteAcceptData> acceptInviteFromUrl(String url) async {
    // Parse invite from URL
    final inviteHandle = await NdrFfi.inviteFromUrl(url);
    return _acceptInvite(inviteHandle);
  }

  @override
  Future<InviteAcceptData> acceptInviteFromEvent(String eventJson) async {
    // Parse invite from event
    final inviteHandle = await NdrFfi.inviteFromEventJson(eventJson);
    return _acceptInvite(inviteHandle);
  }

  Future<InviteAcceptData> _acceptInvite(InviteHandle inviteHandle) async {
    // Get private key
    final privkeyHex = await _getPrivateKey();
    if (privkeyHex == null) {
      throw Exception('Private key not found');
    }

    // Accept the invite
    final acceptResult = await inviteHandle.accept(
      inviteePubkeyHex: _userPubkeyHex,
      inviteePrivkeyHex: privkeyHex,
    );

    // Get inviter pubkey
    final inviterPubkey = await inviteHandle.getInviterPubkeyHex();

    // Publish response event to Nostr relays
    await _nostrService.publishEvent(acceptResult.responseEventJson);

    // Dispose the invite handle (we have the session now)
    await inviteHandle.dispose();

    return InviteAcceptData(
      sessionId: acceptResult.session.id,
      responseEventJson: acceptResult.responseEventJson,
      inviterPubkeyHex: inviterPubkey,
    );
  }

  @override
  Future<String> getInviteUrl(String id, {String root = 'https://iris.to'}) async {
    final handle = await _getInviteHandle(id);
    if (handle == null) {
      throw Exception('Invite not found');
    }
    return handle.toUrl(root);
  }

  @override
  Future<String> getInviteEventJson(String id) async {
    final handle = await _getInviteHandle(id);
    if (handle == null) {
      throw Exception('Invite not found');
    }
    return handle.toEventJson();
  }

  @override
  Future<void> markInviteUsed(String id, String acceptedByPubkey) async {
    await _datasource.markUsed(id, acceptedByPubkey);
  }

  /// Get or restore an invite handle from cache or storage.
  Future<InviteHandle?> _getInviteHandle(String id) async {
    // Check cache first
    if (_inviteHandles.containsKey(id)) {
      return _inviteHandles[id];
    }

    // Try to restore from storage
    final invite = await _datasource.getInvite(id);
    if (invite?.serializedState == null) return null;

    try {
      final handle = await NdrFfi.inviteDeserialize(invite!.serializedState!);
      _inviteHandles[id] = handle;
      return handle;
    } catch (e) {
      return null;
    }
  }

  /// Dispose all cached invite handles.
  Future<void> dispose() async {
    for (final handle in _inviteHandles.values) {
      await handle.dispose();
    }
    _inviteHandles.clear();
  }
}

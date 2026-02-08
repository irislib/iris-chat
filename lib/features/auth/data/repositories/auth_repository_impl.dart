import '../../../../core/ffi/ndr_ffi.dart';
import '../../../../core/services/secure_storage_service.dart';
import '../../domain/models/identity.dart';
import '../../domain/repositories/auth_repository.dart';

/// Implementation of [AuthRepository] using ndr-ffi and secure storage.
class AuthRepositoryImpl implements AuthRepository {
  AuthRepositoryImpl(this._storage);

  final SecureStorageService _storage;

  @override
  Future<Identity> createIdentity() async {
    // Generate new keypair using ndr-ffi
    final keypair = await NdrFfi.generateKeypair();

    // Store keys securely (single-item identity to avoid multiple Keychain prompts).
    await _storage.saveIdentity(
      privkeyHex: keypair.privateKeyHex,
      pubkeyHex: keypair.publicKeyHex,
    );

    return Identity(
      pubkeyHex: keypair.publicKeyHex,
      createdAt: DateTime.now(),
    );
  }

  @override
  Future<Identity> login(String privkeyHex) async {
    // Validate key format
    if (!_isValidPrivateKey(privkeyHex)) {
      throw const InvalidKeyException('Invalid private key format');
    }

    // Derive public key from private key
    // For now, we'll need to implement this or use the FFI
    // The ndr-ffi library should provide this functionality
    final pubkeyHex = await _derivePublicKey(privkeyHex);

    // Store keys securely
    await _storage.saveIdentity(privkeyHex: privkeyHex, pubkeyHex: pubkeyHex);

    return Identity(
      pubkeyHex: pubkeyHex,
      createdAt: DateTime.now(),
    );
  }

  @override
  Future<Identity> loginLinkedDevice({
    required String ownerPubkeyHex,
    required String devicePrivkeyHex,
  }) async {
    // Validate key formats
    if (!_isValidPrivateKey(devicePrivkeyHex)) {
      throw const InvalidKeyException('Invalid private key format');
    }
    if (!_isValidHexKey(ownerPubkeyHex)) {
      throw const InvalidKeyException('Invalid public key format');
    }

    // Derive device pubkey to ensure the private key is usable.
    await _derivePublicKey(devicePrivkeyHex);

    // Store device private key + owner public key.
    await _storage.saveIdentity(
      privkeyHex: devicePrivkeyHex,
      pubkeyHex: ownerPubkeyHex,
    );

    return Identity(
      pubkeyHex: ownerPubkeyHex,
      createdAt: DateTime.now(),
    );
  }

  @override
  Future<Identity?> getCurrentIdentity() async {
    final pubkeyHex = await _storage.getPublicKey();
    if (pubkeyHex == null) return null;

    return Identity(pubkeyHex: pubkeyHex);
  }

  @override
  Future<bool> hasIdentity() async {
    return _storage.hasIdentity();
  }

  @override
  Future<void> logout() async {
    await _storage.clearIdentity();
  }

  @override
  Future<String?> getPrivateKey() async {
    return _storage.getPrivateKey();
  }

  @override
  Future<String?> getDevicePubkeyHex() async {
    final privkeyHex = await _storage.getPrivateKey();
    if (privkeyHex == null) return null;
    try {
      return await _derivePublicKey(privkeyHex);
    } catch (_) {
      return null;
    }
  }

  bool _isValidPrivateKey(String hex) {
    if (hex.length != 64) return false;
    return _isValidHexKey(hex);
  }

  bool _isValidHexKey(String hex) {
    if (hex.length != 64) return false;
    return RegExp(r'^[0-9a-fA-F]+$').hasMatch(hex);
  }

  Future<String> _derivePublicKey(String privkeyHex) async {
    return NdrFfi.derivePublicKey(privkeyHex);
  }
}

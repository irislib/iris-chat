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

    // Store keys securely
    await _storage.savePrivateKey(keypair.privateKeyHex);
    await _storage.savePublicKey(keypair.publicKeyHex);

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
    await _storage.savePrivateKey(privkeyHex);
    await _storage.savePublicKey(pubkeyHex);

    return Identity(
      pubkeyHex: pubkeyHex,
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

  bool _isValidPrivateKey(String hex) {
    if (hex.length != 64) return false;
    return RegExp(r'^[0-9a-fA-F]+$').hasMatch(hex);
  }

  Future<String> _derivePublicKey(String privkeyHex) async {
    return NdrFfi.derivePublicKey(privkeyHex);
  }
}

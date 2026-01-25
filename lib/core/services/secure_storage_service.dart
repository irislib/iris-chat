import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Service for securely storing sensitive data like private keys.
///
/// Uses platform-specific secure storage (Keychain on iOS, EncryptedSharedPreferences on Android).
class SecureStorageService {
  SecureStorageService([FlutterSecureStorage? storage])
      : _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
              iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock_this_device),
            );

  final FlutterSecureStorage _storage;

  static const _privkeyKey = 'iris_chat_privkey';
  static const _pubkeyKey = 'iris_chat_pubkey';

  /// Save the user's private key.
  Future<void> savePrivateKey(String privkeyHex) async {
    await _storage.write(key: _privkeyKey, value: privkeyHex);
  }

  /// Get the stored private key.
  Future<String?> getPrivateKey() async {
    return _storage.read(key: _privkeyKey);
  }

  /// Save the user's public key.
  Future<void> savePublicKey(String pubkeyHex) async {
    await _storage.write(key: _pubkeyKey, value: pubkeyHex);
  }

  /// Get the stored public key.
  Future<String?> getPublicKey() async {
    return _storage.read(key: _pubkeyKey);
  }

  /// Check if an identity exists.
  Future<bool> hasIdentity() async {
    return _storage.containsKey(key: _privkeyKey);
  }

  /// Clear all stored identity data.
  Future<void> clearIdentity() async {
    await _storage.delete(key: _privkeyKey);
    await _storage.delete(key: _pubkeyKey);
  }

  /// Delete all stored data.
  Future<void> deleteAll() async {
    await _storage.deleteAll();
  }
}

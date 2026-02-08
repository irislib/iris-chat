import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Service for securely storing sensitive data like private keys.
///
/// Uses platform-specific secure storage (Keychain on iOS/macOS, EncryptedSharedPreferences on Android).
class SecureStorageService {
  SecureStorageService([FlutterSecureStorage? storage])
      : _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
              iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock_this_device),
              // macOS: Data Protection Keychain requires entitlements that we don't ship with.
              // Disabling it avoids `-34018` ("A required entitlement isn't present.").
              mOptions: MacOsOptions(useDataProtectionKeyChain: false),
            );

  final FlutterSecureStorage _storage;

  // New storage layout: keep identity in a single Keychain/Keystore item so
  // macOS only prompts once on startup (Keychain permissions are per item).
  static const _identityKey = 'iris_chat_identity';
  static const _privkeyKey = 'iris_chat_privkey';
  static const _pubkeyKey = 'iris_chat_pubkey';

  Map<String, String>? _cachedIdentity;
  bool _identityCacheLoaded = false;
  Future<Map<String, String>?>? _identityLoadFuture;

  Map<String, String>? _parseIdentityJson(String raw) {
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return null;
      final priv = decoded['privkeyHex'];
      final pub = decoded['pubkeyHex'];
      if (priv is! String || priv.isEmpty) return null;
      if (pub is! String || pub.isEmpty) return null;
      return {'privkeyHex': priv, 'pubkeyHex': pub};
    } catch (_) {
      return null;
    }
  }

  Future<Map<String, String>?> _loadIdentity() async {
    if (_identityCacheLoaded) return _cachedIdentity;

    final inflight = _identityLoadFuture;
    if (inflight != null) return inflight;

    _identityLoadFuture = () async {
      // Preferred: single-item identity blob.
      final raw = await _storage.read(key: _identityKey);
      if (raw != null && raw.isNotEmpty) {
        final parsed = _parseIdentityJson(raw);
        if (parsed != null) {
          _cachedIdentity = parsed;
          _identityCacheLoaded = true;
          return parsed;
        }
      }

      // Legacy fallback: migrate from two-key storage.
      final priv = await _storage.read(key: _privkeyKey);
      final pub = await _storage.read(key: _pubkeyKey);
      if (priv != null &&
          priv.isNotEmpty &&
          pub != null &&
          pub.isNotEmpty) {
        await saveIdentity(privkeyHex: priv, pubkeyHex: pub);
        return _cachedIdentity;
      }

      _cachedIdentity = null;
      _identityCacheLoaded = true;
      return null;
    }();

    final future = _identityLoadFuture;
    if (future == null) return null;
    final result = await future;
    _identityLoadFuture = null;
    return result;
  }

  /// Save the user's identity (private + public key) as a single secure storage item.
  Future<void> saveIdentity({
    required String privkeyHex,
    required String pubkeyHex,
  }) async {
    final payload = jsonEncode({'privkeyHex': privkeyHex, 'pubkeyHex': pubkeyHex});
    await _storage.write(key: _identityKey, value: payload);

    // Best-effort cleanup: remove legacy keys to avoid double prompts.
    try {
      await _storage.delete(key: _privkeyKey);
    } catch (_) {}
    try {
      await _storage.delete(key: _pubkeyKey);
    } catch (_) {}

    _cachedIdentity = {'privkeyHex': privkeyHex, 'pubkeyHex': pubkeyHex};
    _identityCacheLoaded = true;
  }

  /// Save the user's private key.
  Future<void> savePrivateKey(String privkeyHex) async {
    await _storage.write(key: _privkeyKey, value: privkeyHex);
    // Clear cache; legacy writes should not reuse a cached identity blob.
    _cachedIdentity = null;
    _identityCacheLoaded = false;
  }

  /// Get the stored private key.
  Future<String?> getPrivateKey() async {
    final identity = await _loadIdentity();
    if (identity != null) return identity['privkeyHex'];
    // Fallback for legacy layouts or partial state.
    return _storage.read(key: _privkeyKey);
  }

  /// Save the user's public key.
  Future<void> savePublicKey(String pubkeyHex) async {
    await _storage.write(key: _pubkeyKey, value: pubkeyHex);
    _cachedIdentity = null;
    _identityCacheLoaded = false;
  }

  /// Get the stored public key.
  Future<String?> getPublicKey() async {
    final identity = await _loadIdentity();
    if (identity != null) return identity['pubkeyHex'];
    return _storage.read(key: _pubkeyKey);
  }

  /// Check if an identity exists.
  Future<bool> hasIdentity() async {
    final hasNew = await _storage.containsKey(key: _identityKey);
    if (hasNew) return true;
    return _storage.containsKey(key: _privkeyKey);
  }

  /// Clear all stored identity data.
  Future<void> clearIdentity() async {
    await _storage.delete(key: _identityKey);
    await _storage.delete(key: _privkeyKey);
    await _storage.delete(key: _pubkeyKey);
    _cachedIdentity = null;
    _identityCacheLoaded = false;
  }

  /// Delete all stored data.
  Future<void> deleteAll() async {
    await _storage.deleteAll();
    _cachedIdentity = null;
    _identityCacheLoaded = false;
  }
}

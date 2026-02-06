import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:freezed_annotation/freezed_annotation.dart';

import '../../core/services/secure_storage_service.dart';
import '../../features/auth/data/repositories/auth_repository_impl.dart';
import '../../features/auth/domain/models/identity.dart';
import '../../features/auth/domain/repositories/auth_repository.dart';

part 'auth_provider.freezed.dart';

/// Authentication state.
@freezed
abstract class AuthState with _$AuthState {
  const factory AuthState({
    @Default(false) bool isAuthenticated,
    @Default(false) bool isLoading,
    @Default(false) bool isInitialized,
    @Default(false) bool isLinkedDevice,
    String? pubkeyHex,
    String? devicePubkeyHex,
    String? error,
  }) = _AuthState;
}

/// Notifier for authentication state.
class AuthNotifier extends StateNotifier<AuthState> {
  AuthNotifier(this._repository) : super(const AuthState());

  final AuthRepository _repository;

  /// Check for existing identity on app start.
  Future<void> checkAuth() async {
    state = state.copyWith(isLoading: true);
    try {
      final identity = await _repository.getCurrentIdentity();
      if (identity != null) {
        final devicePubkeyHex = await _repository.getDevicePubkeyHex();
        if (devicePubkeyHex == null) {
          state = state.copyWith(
            isAuthenticated: false,
            isLoading: false,
            isInitialized: true,
            pubkeyHex: null,
            devicePubkeyHex: null,
            isLinkedDevice: false,
            error: 'Private key not found',
          );
          return;
        }
        state = state.copyWith(
          isAuthenticated: true,
          isLoading: false,
          isInitialized: true,
          pubkeyHex: identity.pubkeyHex,
          devicePubkeyHex: devicePubkeyHex,
          isLinkedDevice: devicePubkeyHex != identity.pubkeyHex,
        );
      } else {
        state = state.copyWith(
          isAuthenticated: false,
          isLoading: false,
          isInitialized: true,
          pubkeyHex: null,
          devicePubkeyHex: null,
          isLinkedDevice: false,
        );
      }
    } catch (e) {
      state = state.copyWith(
        isLoading: false,
        isInitialized: true,
        isLinkedDevice: false,
        error: e.toString(),
      );
    }
  }

  /// Create a new identity.
  Future<void> createIdentity() async {
    state = state.copyWith(isLoading: true, error: null);
    try {
      final identity = await _repository.createIdentity();
      state = state.copyWith(
        isAuthenticated: true,
        isLoading: false,
        pubkeyHex: identity.pubkeyHex,
        devicePubkeyHex: identity.pubkeyHex,
        isLinkedDevice: false,
        isInitialized: true,
      );
    } catch (e) {
      state = state.copyWith(
        isLoading: false,
        error: e.toString(),
      );
    }
  }

  /// Login with an existing private key.
  Future<void> login(String privkeyHex) async {
    state = state.copyWith(isLoading: true, error: null);
    try {
      final identity = await _repository.login(privkeyHex);
      state = state.copyWith(
        isAuthenticated: true,
        isLoading: false,
        pubkeyHex: identity.pubkeyHex,
        devicePubkeyHex: identity.pubkeyHex,
        isLinkedDevice: false,
        isInitialized: true,
      );
    } on InvalidKeyException catch (e) {
      state = state.copyWith(
        isLoading: false,
        error: e.message,
      );
    } catch (e) {
      state = state.copyWith(
        isLoading: false,
        error: e.toString(),
      );
    }
  }

  /// Login as a linked device using a device private key and an owner pubkey.
  Future<void> loginLinkedDevice({
    required String ownerPubkeyHex,
    required String devicePrivkeyHex,
  }) async {
    state = state.copyWith(isLoading: true, error: null);
    try {
      final identity = await _repository.loginLinkedDevice(
        ownerPubkeyHex: ownerPubkeyHex,
        devicePrivkeyHex: devicePrivkeyHex,
      );

      final devicePubkeyHex = await _repository.getDevicePubkeyHex();
      state = state.copyWith(
        isAuthenticated: true,
        isLoading: false,
        pubkeyHex: identity.pubkeyHex,
        devicePubkeyHex: devicePubkeyHex,
        isLinkedDevice:
            devicePubkeyHex != null && devicePubkeyHex != identity.pubkeyHex,
        isInitialized: true,
      );
    } on InvalidKeyException catch (e) {
      state = state.copyWith(
        isLoading: false,
        error: e.message,
      );
    } catch (e) {
      state = state.copyWith(
        isLoading: false,
        error: e.toString(),
      );
    }
  }

  /// Logout and clear identity.
  Future<void> logout() async {
    await _repository.logout();
    state = const AuthState(isInitialized: true);
  }

  /// Clear any error state.
  void clearError() {
    state = state.copyWith(error: null);
  }
}

/// Provider for secure storage service.
final secureStorageProvider = Provider<SecureStorageService>((ref) {
  return SecureStorageService();
});

/// Provider for auth repository.
final authRepositoryProvider = Provider<AuthRepository>((ref) {
  final storage = ref.watch(secureStorageProvider);
  return AuthRepositoryImpl(storage);
});

/// Provider for auth state.
final authStateProvider = StateNotifierProvider<AuthNotifier, AuthState>((ref) {
  final repository = ref.watch(authRepositoryProvider);
  return AuthNotifier(repository);
});

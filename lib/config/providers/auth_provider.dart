import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:freezed_annotation/freezed_annotation.dart';

import '../../core/services/secure_storage_service.dart';
import '../../features/auth/data/repositories/auth_repository_impl.dart';
import '../../features/auth/domain/models/identity.dart';
import '../../features/auth/domain/repositories/auth_repository.dart';

part 'auth_provider.freezed.dart';

/// Authentication state.
@freezed
class AuthState with _$AuthState {
  const factory AuthState({
    @Default(false) bool isAuthenticated,
    @Default(false) bool isLoading,
    @Default(false) bool isInitialized,
    String? pubkeyHex,
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
        state = state.copyWith(
          isAuthenticated: true,
          isLoading: false,
          isInitialized: true,
          pubkeyHex: identity.pubkeyHex,
        );
      } else {
        state = state.copyWith(
          isAuthenticated: false,
          isLoading: false,
          isInitialized: true,
        );
      }
    } catch (e) {
      state = state.copyWith(
        isLoading: false,
        isInitialized: true,
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

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_chat/config/providers/auth_provider.dart';
import 'package:iris_chat/config/providers/nostr_provider.dart';
import 'package:iris_chat/core/services/nostr_service.dart';
import 'package:iris_chat/features/auth/domain/models/identity.dart';
import 'package:iris_chat/features/auth/domain/repositories/auth_repository.dart';

class _NoopAuthRepository implements AuthRepository {
  @override
  Future<Identity> createIdentity() {
    throw UnimplementedError();
  }

  @override
  Future<Identity> login(String privkeyHex) {
    throw UnimplementedError();
  }

  @override
  Future<Identity> loginLinkedDevice({
    required String ownerPubkeyHex,
    required String devicePrivkeyHex,
  }) {
    throw UnimplementedError();
  }

  @override
  Future<Identity?> getCurrentIdentity() async => null;

  @override
  Future<bool> hasIdentity() async => false;

  @override
  Future<void> logout() async {}

  @override
  Future<String?> getPrivateKey() async => null;

  @override
  Future<String?> getDevicePubkeyHex() async => null;
}

class _TestAuthNotifier extends AuthNotifier {
  _TestAuthNotifier() : super(_NoopAuthRepository());

  set authState(AuthState next) {
    state = next;
  }
}

void main() {
  group('nostr_provider', () {
    test('sessionManagerServiceProvider rebuilds when auth identity changes', () async {
      final authNotifier = _TestAuthNotifier();

      final container = ProviderContainer(
        overrides: [
          // Avoid real network connections in unit tests.
          nostrServiceProvider.overrideWith(
            (ref) => NostrService(relayUrls: const []),
          ),
          authRepositoryProvider.overrideWith((ref) => _NoopAuthRepository()),
          authStateProvider.overrideWith((ref) => authNotifier),
        ],
      );
      addTearDown(container.dispose);

      final instances = <Object>[];
      final sub = container.listen(
        sessionManagerServiceProvider,
        (prev, next) => instances.add(next),
        fireImmediately: true,
      );
      addTearDown(sub.close);

      expect(instances, hasLength(1));
      final first = instances.first;

      authNotifier.authState =
        const AuthState(
          isAuthenticated: true,
          isInitialized: true,
          pubkeyHex: 'a',
          devicePubkeyHex: 'a',
        );
      await Future<void>.delayed(Duration.zero);

      expect(instances, hasLength(2));
      expect(identical(instances[1], first), isFalse);
    });
  });
}

import 'package:flutter_test/flutter_test.dart';
import 'package:iris_chat/config/providers/auth_provider.dart';
import 'package:iris_chat/features/auth/domain/models/identity.dart';
import 'package:iris_chat/features/auth/domain/repositories/auth_repository.dart';
import 'package:mocktail/mocktail.dart';

class MockAuthRepository extends Mock implements AuthRepository {}

void main() {
  late AuthNotifier notifier;
  late MockAuthRepository mockRepo;

  setUp(() {
    mockRepo = MockAuthRepository();
    notifier = AuthNotifier(mockRepo);
  });

  group('AuthNotifier', () {
    group('initial state', () {
      test('is not authenticated', () {
        expect(notifier.state.isAuthenticated, false);
      });

      test('is not loading', () {
        expect(notifier.state.isLoading, false);
      });

      test('has no pubkey', () {
        expect(notifier.state.pubkeyHex, isNull);
      });

      test('has no device pubkey', () {
        expect(notifier.state.devicePubkeyHex, isNull);
      });

      test('is not a linked device login', () {
        expect(notifier.state.isLinkedDevice, false);
      });

      test('has no error', () {
        expect(notifier.state.error, isNull);
      });
    });

    group('checkAuth', () {
      test('sets isAuthenticated true when identity exists', () async {
        const testPubkey =
            'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
        when(() => mockRepo.getCurrentIdentity()).thenAnswer(
          (_) async => const Identity(pubkeyHex: testPubkey),
        );
        when(() => mockRepo.getDevicePubkeyHex()).thenAnswer(
          (_) async => testPubkey,
        );

        await notifier.checkAuth();

        expect(notifier.state.isAuthenticated, true);
        expect(notifier.state.pubkeyHex, testPubkey);
        expect(notifier.state.devicePubkeyHex, testPubkey);
        expect(notifier.state.isLinkedDevice, false);
        expect(notifier.state.isInitialized, true);
      });

      test('sets isLinkedDevice true when owner differs from device pubkey',
          () async {
        const ownerPubkey =
            'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
        const devicePubkey =
            'b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
        when(() => mockRepo.getCurrentIdentity()).thenAnswer(
          (_) async => const Identity(pubkeyHex: ownerPubkey),
        );
        when(() => mockRepo.getDevicePubkeyHex()).thenAnswer(
          (_) async => devicePubkey,
        );

        await notifier.checkAuth();

        expect(notifier.state.isAuthenticated, true);
        expect(notifier.state.pubkeyHex, ownerPubkey);
        expect(notifier.state.devicePubkeyHex, devicePubkey);
        expect(notifier.state.isLinkedDevice, true);
        expect(notifier.state.isInitialized, true);
      });

      test('sets isAuthenticated false when no identity', () async {
        when(() => mockRepo.getCurrentIdentity()).thenAnswer(
          (_) async => null,
        );

        await notifier.checkAuth();

        expect(notifier.state.isAuthenticated, false);
        expect(notifier.state.pubkeyHex, isNull);
        expect(notifier.state.isInitialized, true);
      });

      test('sets error on exception', () async {
        when(() => mockRepo.getCurrentIdentity()).thenThrow(
          Exception('Storage error'),
        );

        await notifier.checkAuth();

        expect(notifier.state.isAuthenticated, false);
        expect(notifier.state.error, isNotNull);
        expect(notifier.state.isInitialized, true);
      });
    });

    group('createIdentity', () {
      test('sets authenticated on success', () async {
        const testPubkey =
            'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
        when(() => mockRepo.createIdentity()).thenAnswer(
          (_) async => const Identity(pubkeyHex: testPubkey),
        );

        await notifier.createIdentity();

        expect(notifier.state.isAuthenticated, true);
        expect(notifier.state.pubkeyHex, testPubkey);
        expect(notifier.state.devicePubkeyHex, testPubkey);
        expect(notifier.state.isLinkedDevice, false);
        expect(notifier.state.isLoading, false);
      });

      test('sets error on failure', () async {
        when(() => mockRepo.createIdentity()).thenThrow(
          Exception('Keygen failed'),
        );

        await notifier.createIdentity();

        expect(notifier.state.isAuthenticated, false);
        expect(notifier.state.error, isNotNull);
        expect(notifier.state.isLoading, false);
      });
    });

    group('login', () {
      test('sets authenticated on success', () async {
        const testPrivkey =
            'f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4b5a6f1e2';
        const testPubkey =
            'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
        when(() => mockRepo.login(testPrivkey)).thenAnswer(
          (_) async => const Identity(pubkeyHex: testPubkey),
        );

        await notifier.login(testPrivkey);

        expect(notifier.state.isAuthenticated, true);
        expect(notifier.state.pubkeyHex, testPubkey);
        expect(notifier.state.devicePubkeyHex, testPubkey);
        expect(notifier.state.isLinkedDevice, false);
      });

      test('sets error on InvalidKeyException', () async {
        when(() => mockRepo.login(any())).thenThrow(
          const InvalidKeyException('Invalid key format'),
        );

        await notifier.login('invalid');

        expect(notifier.state.isAuthenticated, false);
        expect(notifier.state.error, 'Invalid key format');
      });
    });

    group('loginLinkedDevice', () {
      test('sets authenticated on success', () async {
        const ownerPubkey =
            'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
        const devicePrivkey =
            'f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4b5a6f1e2';
        const devicePubkey =
            'b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

        when(
          () => mockRepo.loginLinkedDevice(
            ownerPubkeyHex: ownerPubkey,
            devicePrivkeyHex: devicePrivkey,
          ),
        ).thenAnswer((_) async => const Identity(pubkeyHex: ownerPubkey));
        when(() => mockRepo.getDevicePubkeyHex()).thenAnswer(
          (_) async => devicePubkey,
        );

        await notifier.loginLinkedDevice(
          ownerPubkeyHex: ownerPubkey,
          devicePrivkeyHex: devicePrivkey,
        );

        expect(notifier.state.isAuthenticated, true);
        expect(notifier.state.pubkeyHex, ownerPubkey);
        expect(notifier.state.devicePubkeyHex, devicePubkey);
        expect(notifier.state.isLinkedDevice, true);
      });
    });

    group('logout', () {
      test('clears authenticated state', () async {
        // First, set up authenticated state
        const testPubkey = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
        when(() => mockRepo.createIdentity()).thenAnswer(
          (_) async => const Identity(pubkeyHex: testPubkey),
        );
        await notifier.createIdentity();
        expect(notifier.state.isAuthenticated, true);

        // Now logout
        when(() => mockRepo.logout()).thenAnswer((_) async {});
        await notifier.logout();

        expect(notifier.state.isAuthenticated, false);
        expect(notifier.state.pubkeyHex, isNull);
        expect(notifier.state.devicePubkeyHex, isNull);
        expect(notifier.state.isLinkedDevice, false);
        expect(notifier.state.isInitialized, true);
      });
    });

    group('clearError', () {
      test('clears error state', () async {
        when(() => mockRepo.login(any())).thenThrow(Exception('Error'));
        await notifier.login('bad');
        expect(notifier.state.error, isNotNull);

        notifier.clearError();

        expect(notifier.state.error, isNull);
      });
    });
  });
}

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_chat/core/services/secure_storage_service.dart';
import 'package:mocktail/mocktail.dart';

class MockFlutterSecureStorage extends Mock implements FlutterSecureStorage {}

void main() {
  late SecureStorageService service;
  late MockFlutterSecureStorage mockStorage;

  setUp(() {
    mockStorage = MockFlutterSecureStorage();
    service = SecureStorageService(mockStorage);
  });

  group('SecureStorageService', () {
    group('savePrivateKey', () {
      test('writes key to secure storage', () async {
        when(() => mockStorage.write(
              key: any(named: 'key'),
              value: any(named: 'value'),
            )).thenAnswer((_) async {});

        await service.savePrivateKey('abc123def456');

        verify(() => mockStorage.write(
              key: 'iris_chat_privkey',
              value: 'abc123def456',
            )).called(1);
      });
    });

    group('getPrivateKey', () {
      test('returns stored key when exists', () async {
        when(() => mockStorage.read(key: 'iris_chat_privkey'))
            .thenAnswer((_) async => 'abc123');

        final result = await service.getPrivateKey();

        expect(result, 'abc123');
      });

      test('returns null when key not found', () async {
        when(() => mockStorage.read(key: 'iris_chat_privkey'))
            .thenAnswer((_) async => null);

        final result = await service.getPrivateKey();

        expect(result, isNull);
      });
    });

    group('savePublicKey', () {
      test('writes key to secure storage', () async {
        when(() => mockStorage.write(
              key: any(named: 'key'),
              value: any(named: 'value'),
            )).thenAnswer((_) async {});

        await service.savePublicKey('pubkey123');

        verify(() => mockStorage.write(
              key: 'iris_chat_pubkey',
              value: 'pubkey123',
            )).called(1);
      });
    });

    group('getPublicKey', () {
      test('returns stored key when exists', () async {
        when(() => mockStorage.read(key: 'iris_chat_pubkey'))
            .thenAnswer((_) async => 'pubkey123');

        final result = await service.getPublicKey();

        expect(result, 'pubkey123');
      });
    });

    group('hasIdentity', () {
      test('returns true when private key exists', () async {
        when(() => mockStorage.containsKey(key: 'iris_chat_privkey'))
            .thenAnswer((_) async => true);

        final result = await service.hasIdentity();

        expect(result, true);
      });

      test('returns false when private key not found', () async {
        when(() => mockStorage.containsKey(key: 'iris_chat_privkey'))
            .thenAnswer((_) async => false);

        final result = await service.hasIdentity();

        expect(result, false);
      });
    });

    group('clearIdentity', () {
      test('deletes both private and public keys', () async {
        when(() => mockStorage.delete(key: any(named: 'key')))
            .thenAnswer((_) async {});

        await service.clearIdentity();

        verify(() => mockStorage.delete(key: 'iris_chat_privkey')).called(1);
        verify(() => mockStorage.delete(key: 'iris_chat_pubkey')).called(1);
      });
    });

    group('deleteAll', () {
      test('deletes all stored data', () async {
        when(() => mockStorage.deleteAll()).thenAnswer((_) async {});

        await service.deleteAll();

        verify(() => mockStorage.deleteAll()).called(1);
      });
    });
  });
}

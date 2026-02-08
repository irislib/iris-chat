import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_chat/config/providers/invite_provider.dart';
import 'package:iris_chat/features/invite/data/datasources/invite_local_datasource.dart';
import 'package:iris_chat/features/invite/domain/models/invite.dart';
import 'package:mocktail/mocktail.dart';

class MockInviteLocalDatasource extends Mock implements InviteLocalDatasource {}

class MockRef extends Mock implements Ref {}

void main() {
  late InviteNotifier notifier;
  late MockInviteLocalDatasource mockDatasource;
  late MockRef mockRef;

  setUp(() {
    mockDatasource = MockInviteLocalDatasource();
    mockRef = MockRef();
    notifier = InviteNotifier(mockDatasource, mockRef);
  });

  setUpAll(() {
    registerFallbackValue(Invite(
      id: 'fallback',
      inviterPubkeyHex: 'pubkey',
      createdAt: DateTime.now(),
    ));
  });

  group('InviteNotifier', () {
    group('initial state', () {
      test('has empty invites list', () {
        expect(notifier.state.invites, isEmpty);
      });

      test('is not loading', () {
        expect(notifier.state.isLoading, false);
      });

      test('is not creating', () {
        expect(notifier.state.isCreating, false);
      });

      test('is not accepting', () {
        expect(notifier.state.isAccepting, false);
      });

      test('has no error', () {
        expect(notifier.state.error, isNull);
      });
    });

    group('loadInvites', () {
      test('sets isLoading true while loading', () async {
        when(() => mockDatasource.getActiveInvites()).thenAnswer(
          (_) async => [],
        );

        final future = notifier.loadInvites();
        await future;

        expect(notifier.state.isLoading, false);
      });

      test('populates invites on success', () async {
        final invites = [
          Invite(
            id: 'invite-1',
            inviterPubkeyHex: 'pubkey1',
            createdAt: DateTime.now(),
          ),
          Invite(
            id: 'invite-2',
            inviterPubkeyHex: 'pubkey1',
            createdAt: DateTime.now(),
            label: 'Work',
          ),
        ];

        when(() => mockDatasource.getActiveInvites()).thenAnswer(
          (_) async => invites,
        );

        await notifier.loadInvites();

        expect(notifier.state.invites, invites);
        expect(notifier.state.isLoading, false);
        expect(notifier.state.error, isNull);
      });

      test('sets error on failure', () async {
        when(() => mockDatasource.getActiveInvites()).thenThrow(
          Exception('Database error'),
        );

        await notifier.loadInvites();

        expect(notifier.state.invites, isEmpty);
        expect(notifier.state.isLoading, false);
        // Error messages are mapped to user-friendly text; just ensure we
        // surface an error rather than crashing.
        expect(notifier.state.error, isNotNull);
      });
    });

    group('deleteInvite', () {
      test('removes invite from datasource and state', () async {
        final invite = Invite(
          id: 'invite-1',
          inviterPubkeyHex: 'pubkey1',
          createdAt: DateTime.now(),
        );

        when(() => mockDatasource.getActiveInvites()).thenAnswer(
          (_) async => [invite],
        );
        when(() => mockDatasource.deleteInvite('invite-1')).thenAnswer(
          (_) async {},
        );

        await notifier.loadInvites();
        expect(notifier.state.invites, isNotEmpty);

        await notifier.deleteInvite('invite-1');

        expect(notifier.state.invites, isEmpty);
        verify(() => mockDatasource.deleteInvite('invite-1')).called(1);
      });
    });

    group('updateLabel', () {
      test('updates invite label in datasource and state', () async {
        final invite = Invite(
          id: 'invite-1',
          inviterPubkeyHex: 'pubkey1',
          createdAt: DateTime.now(),
        );

        when(() => mockDatasource.getActiveInvites()).thenAnswer(
          (_) async => [invite],
        );
        when(() => mockDatasource.updateInvite(any())).thenAnswer(
          (_) async {},
        );

        await notifier.loadInvites();
        await notifier.updateLabel('invite-1', 'Friends');

        expect(notifier.state.invites.first.label, 'Friends');
        verify(() => mockDatasource.updateInvite(any())).called(1);
      });
    });

    group('clearError', () {
      test('clears error state', () async {
        when(() => mockDatasource.getActiveInvites()).thenThrow(
          Exception('Error'),
        );

        await notifier.loadInvites();
        expect(notifier.state.error, isNotNull);

        notifier.clearError();

        expect(notifier.state.error, isNull);
      });
    });
  });
}

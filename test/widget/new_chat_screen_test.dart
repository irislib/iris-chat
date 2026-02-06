import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_chat/config/providers/chat_provider.dart';
import 'package:iris_chat/config/providers/invite_provider.dart';
import 'package:iris_chat/core/services/profile_service.dart';
import 'package:iris_chat/features/chat/data/datasources/session_local_datasource.dart';
import 'package:iris_chat/features/chat/presentation/screens/new_chat_screen.dart';
import 'package:iris_chat/features/invite/data/datasources/invite_local_datasource.dart';
import 'package:iris_chat/features/invite/domain/models/invite.dart';
import 'package:mocktail/mocktail.dart';

import '../test_helpers.dart';

class _MockInviteLocalDatasource extends Mock
    implements InviteLocalDatasource {}

class _MockSessionLocalDatasource extends Mock
    implements SessionLocalDatasource {}

class _MockProfileService extends Mock implements ProfileService {}

class _TestInviteNotifier extends InviteNotifier {
  // ignore: use_super_parameters
  _TestInviteNotifier(
    InviteLocalDatasource datasource,
    Ref ref, {
    required this.initialInvites,
  }) : super(datasource, ref);

  final List<Invite> initialInvites;
  int createCalls = 0;
  String? lastLabel;

  @override
  Future<void> loadInvites() async {
    state = state.copyWith(
      invites: initialInvites,
      isLoading: false,
      error: null,
    );
  }

  @override
  Future<Invite?> createInvite({String? label, int? maxUses}) async {
    createCalls++;
    lastLabel = label;
    final invite = Invite(
      id: 'invite-$createCalls',
      inviterPubkeyHex: 'pubkey',
      label: label,
      createdAt: DateTime(2026, 1, 1),
      maxUses: maxUses,
      serializedState: '{}',
    );
    state = state.copyWith(
      invites: [invite, ...state.invites],
      isCreating: false,
      error: null,
    );
    return invite;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('pasting a chat.iris.to/#npub link shows a friendly error', (
    tester,
  ) async {
    final mockInvites = _MockInviteLocalDatasource();
    final mockSessions = _MockSessionLocalDatasource();
    final mockProfiles = _MockProfileService();

    when(mockInvites.getActiveInvites).thenAnswer(
      (_) async => [
        Invite(
          id: 'existing',
          inviterPubkeyHex: 'pubkey',
          createdAt: DateTime(2026, 1, 1),
          serializedState: '{}',
        ),
      ],
    );

    await tester.pumpWidget(
      createTestApp(
        const NewChatScreen(),
        overrides: [
          inviteDatasourceProvider.overrideWithValue(mockInvites),
          sessionStateProvider.overrideWith((ref) {
            final notifier = SessionNotifier(mockSessions, mockProfiles);
            notifier.state = const SessionState(sessions: []);
            return notifier;
          }),
        ],
      ),
    );
    await tester.pumpAndSettle();

    const url =
        'https://chat.iris.to/#npub143rgr4cphs52qxt864lz8crt7nsagkn68zufs473p2zw67u3xh0qka59k2';
    await tester.enterText(find.byType(TextField), url);
    await tester.pump();

    // Submit (e.g., keyboard "done").
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();

    // Avoid matching the input field (it also contains "npub").
    expect(find.textContaining('Nostr profile'), findsOneWidget);
  });

  testWidgets('Create New Invite button calls createInvite()', (tester) async {
    final mockInvites = _MockInviteLocalDatasource();
    final mockSessions = _MockSessionLocalDatasource();
    final mockProfiles = _MockProfileService();

    late _TestInviteNotifier notifier;

    final initialInvites = [
      Invite(
        id: 'existing',
        inviterPubkeyHex: 'pubkey',
        createdAt: DateTime(2026, 1, 1),
        serializedState: '{}',
      ),
    ];

    await tester.pumpWidget(
      createTestApp(
        const NewChatScreen(),
        overrides: [
          inviteStateProvider.overrideWith((ref) {
            notifier = _TestInviteNotifier(
              mockInvites,
              ref,
              initialInvites: initialInvites,
            );
            return notifier;
          }),
          sessionStateProvider.overrideWith((ref) {
            final notifier = SessionNotifier(mockSessions, mockProfiles);
            notifier.state = const SessionState(sessions: []);
            return notifier;
          }),
        ],
      ),
    );
    await tester.pumpAndSettle();

    expect(notifier.createCalls, 0);

    await tester.tap(find.text('Create New Invite'));
    await tester.pumpAndSettle();

    expect(notifier.createCalls, 1);
    expect(notifier.lastLabel, 'Invite #2');
  });
}

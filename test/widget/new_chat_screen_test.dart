import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:iris_chat/config/providers/chat_provider.dart';
import 'package:iris_chat/config/providers/invite_provider.dart';
import 'package:iris_chat/core/services/profile_service.dart';
import 'package:iris_chat/features/chat/data/datasources/session_local_datasource.dart';
import 'package:iris_chat/features/chat/domain/models/session.dart';
import 'package:iris_chat/features/chat/presentation/screens/new_chat_screen.dart';
import 'package:iris_chat/features/invite/data/datasources/invite_local_datasource.dart';
import 'package:iris_chat/features/invite/domain/models/invite.dart';
import 'package:mocktail/mocktail.dart';
import 'package:nostr/nostr.dart' as nostr;

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

  setUpAll(() {
    registerFallbackValue(
      ChatSession(
        id: 'fallback',
        recipientPubkeyHex: testPubkeyHex,
        createdAt: DateTime(2026, 1, 1),
      ),
    );
  });

  testWidgets('pasting a chat.iris.to/#npub link opens a chat', (tester) async {
    final mockInvites = _MockInviteLocalDatasource();
    final mockSessions = _MockSessionLocalDatasource();
    final mockProfiles = _MockProfileService();
    late SessionNotifier sessionNotifier;

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
    // Simulate a DB lock/hang: join should still navigate immediately.
    final completer = Completer<ChatSession?>();
    when(
      () => mockSessions.getSessionByRecipient(any()),
    ).thenAnswer((_) => completer.future);
    when(() => mockSessions.insertSessionIfAbsent(any())).thenAnswer((_) async {});

    final npub = nostr.Nip19.encodePubkey(testPubkeyHex) as String;
    // Some sources copy these links with a newline between origin and fragment.
    final url = 'https://chat.iris.to/\\n#$npub';

    final router = GoRouter(
      routes: [
        GoRoute(path: '/', builder: (context, state) => const NewChatScreen()),
        GoRoute(
          path: '/chats/:id',
          builder: (context, state) {
            final id = state.pathParameters['id']!;
            return Scaffold(body: Text('Chat:$id'));
          },
        ),
      ],
    );

    await tester.pumpWidget(
      createTestRouterApp(
        router,
        overrides: [
          inviteDatasourceProvider.overrideWithValue(mockInvites),
          sessionStateProvider.overrideWith((ref) {
            sessionNotifier = SessionNotifier(mockSessions, mockProfiles);
            sessionNotifier.state = const SessionState(sessions: []);
            return sessionNotifier;
          }),
        ],
      ),
    );
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), url);
    await tester.pumpAndSettle();

    // Navigated to the chat route using the decoded hex pubkey.
    expect(find.text('Chat:$testPubkeyHex'), findsOneWidget);
    expect(sessionNotifier.state.sessions, isNotEmpty);
    expect(sessionNotifier.state.sessions.first.id, testPubkeyHex);
  });

  testWidgets('New Group card is below New Chat card', (tester) async {
    final mockInvites = _MockInviteLocalDatasource();
    final mockSessions = _MockSessionLocalDatasource();
    final mockProfiles = _MockProfileService();

    late _TestInviteNotifier inviteNotifier;

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
            inviteNotifier = _TestInviteNotifier(
              mockInvites,
              ref,
              initialInvites: initialInvites,
            );
            return inviteNotifier;
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

    final join = find.text('Join Chat');
    final newChat = find.text('New Chat');
    final newGroup = find.text('New Group');

    expect(join, findsOneWidget);
    expect(newChat, findsOneWidget);
    expect(newGroup, findsOneWidget);

    final joinDy = tester.getTopLeft(join).dy;
    final chatDy = tester.getTopLeft(newChat).dy;
    final groupDy = tester.getTopLeft(newGroup).dy;

    expect(joinDy, lessThan(chatDy));
    expect(chatDy, lessThan(groupDy));
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

    final createInviteButton = find.text('Create New Invite');
    await tester.ensureVisible(createInviteButton);
    await tester.pumpAndSettle();
    await tester.tap(createInviteButton);
    await tester.pumpAndSettle();

    expect(notifier.createCalls, 1);
    expect(notifier.lastLabel, 'Invite #2');
  });
}

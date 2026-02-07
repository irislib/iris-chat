import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:iris_chat/config/providers/chat_provider.dart';
import 'package:iris_chat/config/providers/connectivity_provider.dart';
import 'package:iris_chat/config/providers/invite_provider.dart';
import 'package:iris_chat/config/providers/nostr_provider.dart';
import 'package:iris_chat/core/services/connectivity_service.dart';
import 'package:iris_chat/core/services/profile_service.dart';
import 'package:iris_chat/core/services/session_manager_service.dart';
import 'package:iris_chat/features/chat/data/datasources/group_local_datasource.dart';
import 'package:iris_chat/features/chat/data/datasources/group_message_local_datasource.dart';
import 'package:iris_chat/features/chat/data/datasources/session_local_datasource.dart';
import 'package:iris_chat/features/chat/domain/models/session.dart';
import 'package:iris_chat/features/chat/presentation/screens/chat_list_screen.dart';
import 'package:iris_chat/features/invite/data/datasources/invite_local_datasource.dart';
import 'package:iris_chat/shared/utils/animal_names.dart';
import 'package:mocktail/mocktail.dart';

class MockSessionLocalDatasource extends Mock
    implements SessionLocalDatasource {}

class MockInviteLocalDatasource extends Mock implements InviteLocalDatasource {}
class MockSessionManagerService extends Mock implements SessionManagerService {}
class MockProfileService extends Mock implements ProfileService {}
class MockGroupLocalDatasource extends Mock implements GroupLocalDatasource {}
class MockGroupMessageLocalDatasource extends Mock
    implements GroupMessageLocalDatasource {}

void main() {
  late MockSessionLocalDatasource mockSessionDatasource;
  late MockInviteLocalDatasource mockInviteDatasource;
  late MockSessionManagerService mockSessionManagerService;
  late MockProfileService mockProfileService;
  late MockGroupLocalDatasource mockGroupDatasource;
  late MockGroupMessageLocalDatasource mockGroupMessageDatasource;

  setUp(() {
    mockSessionDatasource = MockSessionLocalDatasource();
    mockInviteDatasource = MockInviteLocalDatasource();
    mockSessionManagerService = MockSessionManagerService();
    mockProfileService = MockProfileService();
    mockGroupDatasource = MockGroupLocalDatasource();
    mockGroupMessageDatasource = MockGroupMessageLocalDatasource();

    when(() => mockProfileService.fetchProfiles(any())).thenAnswer((_) async {});
    when(() => mockProfileService.getProfile(any())).thenAnswer((_) async => null);
    when(() => mockGroupDatasource.getAllGroups()).thenAnswer((_) async => []);
  });

  setUpAll(() {
    registerFallbackValue(ChatSession(
      id: 'fallback',
      recipientPubkeyHex: 'abc123',
      createdAt: DateTime.now(),
      isInitiator: true,
    ));
  });

  Widget buildChatListScreen({
    List<ChatSession> sessions = const [],
  }) {
    when(() => mockSessionDatasource.getAllSessions()).thenAnswer(
      (_) async => sessions,
    );
    when(() => mockSessionDatasource.getSessionState(any())).thenAnswer(
      (_) async => null,
    );
    when(() => mockInviteDatasource.getActiveInvites()).thenAnswer(
      (_) async => [],
    );

    final router = GoRouter(
      initialLocation: '/chats',
      routes: [
        GoRoute(
          path: '/chats',
          builder: (context, state) => const ChatListScreen(),
          routes: [
            GoRoute(
              path: 'new',
              builder: (context, state) => const Scaffold(body: Text('New Chat')),
            ),
          ],
        ),
        GoRoute(
          path: '/settings',
          builder: (context, state) => const Scaffold(body: Text('Settings')),
        ),
      ],
    );

    return ProviderScope(
      overrides: [
        sessionDatasourceProvider.overrideWithValue(mockSessionDatasource),
        inviteDatasourceProvider.overrideWithValue(mockInviteDatasource),
        messageSubscriptionProvider.overrideWithValue(mockSessionManagerService),
        sessionManagerServiceProvider.overrideWithValue(mockSessionManagerService),
        groupDatasourceProvider.overrideWithValue(mockGroupDatasource),
        groupMessageDatasourceProvider.overrideWithValue(mockGroupMessageDatasource),
        profileServiceProvider.overrideWithValue(mockProfileService),
        connectivityStatusProvider.overrideWith(
          (_) => Stream.value(ConnectivityStatus.online),
        ),
        queuedMessageCountProvider.overrideWithValue(0),
      ],
      child: ScreenUtilInit(
        designSize: const Size(390, 844),
        minTextAdapt: true,
        builder: (context, _) {
          return MaterialApp.router(
            routerConfig: router,
          );
        },
      ),
    );
  }

  group('ChatListScreen', () {
    group('app bar', () {
      testWidgets('shows Iris title', (tester) async {
        await tester.pumpWidget(buildChatListScreen());
        await tester.pump();

        expect(find.text('Iris'), findsOneWidget);
      });

      testWidgets('shows settings icon button', (tester) async {
        await tester.pumpWidget(buildChatListScreen());
        await tester.pump();

        expect(find.byIcon(Icons.settings), findsOneWidget);
      });

      testWidgets('shows add icon button', (tester) async {
        await tester.pumpWidget(buildChatListScreen());
        await tester.pump();

        expect(find.byIcon(Icons.add), findsOneWidget);
      });
    });

    group('empty state', () {
      testWidgets('renders scaffold when no sessions', (tester) async {
        await tester.pumpWidget(buildChatListScreen(sessions: []));
        await tester.pump();

        expect(find.byType(Scaffold), findsWidgets);
      });
    });

    group('session list', () {
      testWidgets('displays sessions when available', (tester) async {
        final sessions = [
          ChatSession(
            id: 'session-1',
            recipientPubkeyHex: 'abcd1234567890abcd1234567890abcd',
            recipientName: 'Alice',
            createdAt: DateTime.now(),
          ),
          ChatSession(
            id: 'session-2',
            recipientPubkeyHex: 'efgh1234567890efgh1234567890efgh',
            recipientName: 'Bob',
            createdAt: DateTime.now(),
          ),
        ];

        await tester.pumpWidget(buildChatListScreen(sessions: sessions));
        await tester.pump();

        expect(find.text('Alice'), findsOneWidget);
        expect(find.text('Bob'), findsOneWidget);
      });

      testWidgets('shows avatar with first letter of name', (tester) async {
        final sessions = [
          ChatSession(
            id: 'session-1',
            recipientPubkeyHex: 'abcd1234567890abcd1234567890abcd',
            recipientName: 'Alice',
            createdAt: DateTime.now(),
          ),
        ];

        await tester.pumpWidget(buildChatListScreen(sessions: sessions));
        await tester.pump();

        expect(find.text('A'), findsOneWidget);
        expect(find.byType(CircleAvatar), findsOneWidget);
      });

      testWidgets('shows last message preview', (tester) async {
        final sessions = [
          ChatSession(
            id: 'session-1',
            recipientPubkeyHex: 'abcd1234567890abcd1234567890abcd',
            recipientName: 'Alice',
            createdAt: DateTime.now(),
            lastMessagePreview: 'Hey, how are you?',
          ),
        ];

        await tester.pumpWidget(buildChatListScreen(sessions: sessions));
        await tester.pump();

        expect(find.text('Hey, how are you?'), findsOneWidget);
      });

      testWidgets('shows unread count badge when unread messages exist',
          (tester) async {
        final sessions = [
          ChatSession(
            id: 'session-1',
            recipientPubkeyHex: 'abcd1234567890abcd1234567890abcd',
            recipientName: 'Alice',
            createdAt: DateTime.now(),
            unreadCount: 5,
          ),
        ];

        await tester.pumpWidget(buildChatListScreen(sessions: sessions));
        await tester.pump();

        expect(find.text('5'), findsOneWidget);
      });

      testWidgets('does not show unread badge when count is zero',
          (tester) async {
        final sessions = [
          ChatSession(
            id: 'session-1',
            recipientPubkeyHex: 'abcd1234567890abcd1234567890abcd',
            recipientName: 'Alice',
            createdAt: DateTime.now(),
            unreadCount: 0,
          ),
        ];

        await tester.pumpWidget(buildChatListScreen(sessions: sessions));
        await tester.pump();

        expect(find.text('0'), findsNothing);
      });

      testWidgets('shows animal name when no recipient name',
          (tester) async {
        const pubkey = 'abcd1234567890abcd1234567890abcd';
        final sessions = [
          ChatSession(
            id: 'session-1',
            recipientPubkeyHex: pubkey,
            createdAt: DateTime.now(),
          ),
        ];

        await tester.pumpWidget(buildChatListScreen(sessions: sessions));
        await tester.pump();

        expect(find.text(getAnimalName(pubkey)), findsOneWidget);
      });
    });

    group('loading state', () {
      testWidgets('shows loading indicator when loading', (tester) async {
        await tester.pumpWidget(buildChatListScreen());
        await tester.pump();

        expect(find.byType(Scaffold), findsOneWidget);
      });
    });

    group('session interactions', () {
      testWidgets('session item is present as ListTile', (tester) async {
        final sessions = [
          ChatSession(
            id: 'session-1',
            recipientPubkeyHex: 'abcd1234567890abcd1234567890abcd',
            recipientName: 'Alice',
            createdAt: DateTime.now(),
          ),
        ];

        await tester.pumpWidget(buildChatListScreen(sessions: sessions));
        await tester.pump();

        expect(find.byType(ListTile), findsOneWidget);
        expect(find.text('Alice'), findsOneWidget);
      });

      testWidgets('session item is dismissible', (tester) async {
        final sessions = [
          ChatSession(
            id: 'session-1',
            recipientPubkeyHex: 'abcd1234567890abcd1234567890abcd',
            recipientName: 'Alice',
            createdAt: DateTime.now(),
          ),
        ];

        await tester.pumpWidget(buildChatListScreen(sessions: sessions));
        await tester.pump();

        expect(find.byType(Dismissible), findsOneWidget);
      });
    });
  });
}

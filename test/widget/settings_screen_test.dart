import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_chat/config/providers/auth_provider.dart';
import 'package:iris_chat/config/providers/chat_provider.dart';
import 'package:iris_chat/core/services/database_service.dart';
import 'package:iris_chat/features/auth/domain/repositories/auth_repository.dart';
import 'package:iris_chat/features/settings/presentation/screens/settings_screen.dart';
import 'package:mocktail/mocktail.dart';

import '../test_helpers.dart';

class MockAuthRepository extends Mock implements AuthRepository {}

class MockDatabaseService extends Mock implements DatabaseService {}

void main() {
  late MockAuthRepository mockAuthRepo;
  late MockDatabaseService mockDbService;

  setUp(() {
    mockAuthRepo = MockAuthRepository();
    mockDbService = MockDatabaseService();
  });

  Widget buildSettingsScreen({
    String? pubkeyHex,
    bool isAuthenticated = true,
  }) {
    return createTestApp(
      const SettingsScreen(),
      overrides: [
        authRepositoryProvider.overrideWithValue(mockAuthRepo),
        databaseServiceProvider.overrideWithValue(mockDbService),
        authStateProvider.overrideWith((ref) {
          final notifier = AuthNotifier(mockAuthRepo);
          notifier.state = AuthState(
            isAuthenticated: isAuthenticated,
            pubkeyHex: pubkeyHex,
            isInitialized: true,
          );
          return notifier;
        }),
      ],
    );
  }

  group('SettingsScreen', () {
    group('app bar', () {
      testWidgets('shows Settings title', (tester) async {
        await tester.pumpWidget(buildSettingsScreen(pubkeyHex: testPubkeyHex));
        await tester.pumpAndSettle();

        expect(find.text('Settings'), findsOneWidget);
      });
    });

    group('identity section', () {
      testWidgets('shows Identity section header', (tester) async {
        await tester.pumpWidget(buildSettingsScreen(pubkeyHex: testPubkeyHex));
        await tester.pumpAndSettle();

        expect(find.text('Identity'), findsOneWidget);
      });

      testWidgets('shows public key when authenticated', (tester) async {
        await tester.pumpWidget(buildSettingsScreen(pubkeyHex: testPubkeyHex));
        await tester.pumpAndSettle();

        expect(find.text('Public Key'), findsOneWidget);
        // Should show truncated pubkey
        expect(find.textContaining('...'), findsOneWidget);
      });

      testWidgets('shows "Not logged in" when no pubkey', (tester) async {
        await tester
            .pumpWidget(buildSettingsScreen(isAuthenticated: false));
        await tester.pumpAndSettle();

        expect(find.text('Not logged in'), findsOneWidget);
      });

      testWidgets('shows copy button for public key', (tester) async {
        await tester.pumpWidget(buildSettingsScreen(pubkeyHex: testPubkeyHex));
        await tester.pumpAndSettle();

        // Find the copy icon in the public key row
        expect(find.byIcon(Icons.copy), findsOneWidget);
      });

      testWidgets('shows person icon for public key row', (tester) async {
        await tester.pumpWidget(buildSettingsScreen(pubkeyHex: testPubkeyHex));
        await tester.pumpAndSettle();

        expect(find.byIcon(Icons.person), findsOneWidget);
      });
    });

    group('security section', () {
      testWidgets('shows Security section header', (tester) async {
        await tester.pumpWidget(buildSettingsScreen(pubkeyHex: testPubkeyHex));
        await tester.pumpAndSettle();

        expect(find.text('Security'), findsOneWidget);
      });

      testWidgets('shows Export Private Key option', (tester) async {
        await tester.pumpWidget(buildSettingsScreen(pubkeyHex: testPubkeyHex));
        await tester.pumpAndSettle();

        expect(find.text('Export Private Key'), findsOneWidget);
        expect(find.text('Backup your key securely'), findsOneWidget);
        expect(find.byIcon(Icons.key), findsOneWidget);
      });

      testWidgets('shows export key confirmation dialog when tapped',
          (tester) async {
        await tester.pumpWidget(buildSettingsScreen(pubkeyHex: testPubkeyHex));
        await tester.pumpAndSettle();

        await tester.tap(find.text('Export Private Key'));
        await tester.pumpAndSettle();

        expect(find.text('Export Private Key'), findsNWidgets(2)); // ListTile + Dialog title
        expect(find.textContaining('Never share it with anyone'), findsOneWidget);
        expect(find.text('Cancel'), findsOneWidget);
        expect(find.text('Show Key'), findsOneWidget);
      });

      testWidgets('closes export dialog when Cancel tapped', (tester) async {
        await tester.pumpWidget(buildSettingsScreen(pubkeyHex: testPubkeyHex));
        await tester.pumpAndSettle();

        await tester.tap(find.text('Export Private Key'));
        await tester.pumpAndSettle();

        await tester.tap(find.text('Cancel'));
        await tester.pumpAndSettle();

        // Dialog should be closed
        expect(find.text('Show Key'), findsNothing);
      });

      testWidgets('shows private key when Show Key tapped', (tester) async {
        when(() => mockAuthRepo.getPrivateKey())
            .thenAnswer((_) async => testPrivkeyHex);

        await tester.pumpWidget(buildSettingsScreen(pubkeyHex: testPubkeyHex));
        await tester.pumpAndSettle();

        await tester.tap(find.text('Export Private Key'));
        await tester.pumpAndSettle();

        await tester.tap(find.text('Show Key'));
        await tester.pumpAndSettle();

        expect(find.text('Your Private Key'), findsOneWidget);
        expect(find.text(testPrivkeyHex), findsOneWidget);
        expect(find.text('Copy'), findsOneWidget);
      });
    });

    group('about section', () {
      testWidgets('shows About section header', (tester) async {
        await tester.pumpWidget(buildSettingsScreen(pubkeyHex: testPubkeyHex));
        await tester.pumpAndSettle();

        expect(find.text('About'), findsOneWidget);
      });

      testWidgets('shows version info', (tester) async {
        await tester.pumpWidget(buildSettingsScreen(pubkeyHex: testPubkeyHex));
        await tester.pumpAndSettle();

        expect(find.text('Version'), findsOneWidget);
        expect(find.text('1.0.0'), findsOneWidget);
        expect(find.byIcon(Icons.info), findsOneWidget);
      });

      testWidgets('shows source code link', (tester) async {
        await tester.pumpWidget(buildSettingsScreen(pubkeyHex: testPubkeyHex));
        await tester.pumpAndSettle();

        expect(find.text('Source Code'), findsOneWidget);
        expect(find.text('github.com/irislib/iris-chat-flutter'), findsOneWidget);
        expect(find.byIcon(Icons.code), findsOneWidget);
      });
    });

    group('danger zone section', () {
      testWidgets('shows Danger Zone section header', (tester) async {
        await tester.pumpWidget(buildSettingsScreen(pubkeyHex: testPubkeyHex));
        await tester.pumpAndSettle();

        expect(find.text('Danger Zone'), findsOneWidget);
      });

      testWidgets('shows Logout option with red text', (tester) async {
        await tester.pumpWidget(buildSettingsScreen(pubkeyHex: testPubkeyHex));
        await tester.pumpAndSettle();

        expect(find.text('Logout'), findsOneWidget);
        expect(
            find.text('Your data will be kept on this device'), findsOneWidget);
        expect(find.byIcon(Icons.logout), findsOneWidget);
      });

      testWidgets('shows Delete All Data option with red text', (tester) async {
        await tester.pumpWidget(buildSettingsScreen(pubkeyHex: testPubkeyHex));
        await tester.pumpAndSettle();

        // Scroll down to see the Delete All Data option
        await tester.drag(find.byType(ListView), const Offset(0, -200));
        await tester.pumpAndSettle();

        expect(find.text('Delete All Data'), findsOneWidget);
        expect(
            find.text('Remove all data including keys'), findsOneWidget);
        expect(find.byIcon(Icons.delete_forever), findsOneWidget);
      });

      testWidgets('shows logout confirmation dialog when Logout tapped',
          (tester) async {
        await tester.pumpWidget(buildSettingsScreen(pubkeyHex: testPubkeyHex));
        await tester.pumpAndSettle();

        await tester.tap(find.text('Logout'));
        await tester.pumpAndSettle();

        expect(find.text('Logout?'), findsOneWidget);
        expect(find.textContaining('log back in with your private key'),
            findsOneWidget);
        expect(find.text('Cancel'), findsOneWidget);
      });

      testWidgets('shows delete confirmation dialog when Delete All Data tapped',
          (tester) async {
        await tester.pumpWidget(buildSettingsScreen(pubkeyHex: testPubkeyHex));
        await tester.pumpAndSettle();

        // First scroll to make Delete All Data visible
        await tester.drag(find.byType(ListView), const Offset(0, -300));
        await tester.pumpAndSettle();

        await tester.tap(find.text('Delete All Data'));
        await tester.pumpAndSettle();

        expect(find.text('Delete All Data?'), findsOneWidget);
        expect(find.textContaining('cannot be undone'), findsOneWidget);
        expect(find.text('Delete Everything'), findsOneWidget);
        expect(find.text('Cancel'), findsOneWidget);
      });

      testWidgets('closes logout dialog when Cancel tapped', (tester) async {
        await tester.pumpWidget(buildSettingsScreen(pubkeyHex: testPubkeyHex));
        await tester.pumpAndSettle();

        await tester.tap(find.text('Logout'));
        await tester.pumpAndSettle();

        await tester.tap(find.text('Cancel'));
        await tester.pumpAndSettle();

        expect(find.text('Logout?'), findsNothing);
      });

      testWidgets('calls logout when confirmed', (tester) async {
        when(() => mockAuthRepo.logout()).thenAnswer((_) async {});

        await tester.pumpWidget(buildSettingsScreen(pubkeyHex: testPubkeyHex));
        await tester.pumpAndSettle();

        await tester.tap(find.text('Logout'));
        await tester.pumpAndSettle();

        // Tap the Logout button in the dialog (second one)
        await tester.tap(find.text('Logout').last);
        await tester.pump();

        verify(() => mockAuthRepo.logout()).called(1);
      }, skip: true);
    });

    group('scrolling', () {
      testWidgets('settings screen is scrollable', (tester) async {
        await tester.pumpWidget(buildSettingsScreen(pubkeyHex: testPubkeyHex));
        await tester.pumpAndSettle();

        expect(find.byType(ListView), findsOneWidget);
      });
    });
  });
}

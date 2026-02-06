import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_chat/config/providers/auth_provider.dart';
import 'package:iris_chat/config/providers/invite_provider.dart';
import 'package:iris_chat/features/auth/domain/repositories/auth_repository.dart';
import 'package:iris_chat/features/invite/data/datasources/invite_local_datasource.dart';
import 'package:iris_chat/features/invite/domain/models/invite.dart';
import 'package:iris_chat/features/invite/presentation/screens/scan_invite_screen.dart';
import 'package:mocktail/mocktail.dart';

import '../test_helpers.dart';

class MockInviteLocalDatasource extends Mock implements InviteLocalDatasource {}

class MockAuthRepository extends Mock implements AuthRepository {}

void main() {
  late MockInviteLocalDatasource mockInviteDatasource;
  late MockAuthRepository mockAuthRepo;

  setUp(() {
    mockInviteDatasource = MockInviteLocalDatasource();
    mockAuthRepo = MockAuthRepository();
  });

  setUpAll(() {
    registerFallbackValue(
      Invite(
        id: 'fallback',
        inviterPubkeyHex: 'pubkey',
        createdAt: DateTime.now(),
      ),
    );
  });

  Widget buildScanInviteScreen({bool isAccepting = false, String? error}) {
    return createTestApp(
      const ScanInviteScreen(),
      overrides: [
        inviteDatasourceProvider.overrideWithValue(mockInviteDatasource),
        authRepositoryProvider.overrideWithValue(mockAuthRepo),
        authStateProvider.overrideWith((ref) {
          final notifier = AuthNotifier(mockAuthRepo);
          notifier.state = const AuthState(
            isAuthenticated: true,
            pubkeyHex: testPubkeyHex,
            isInitialized: true,
          );
          return notifier;
        }),
        inviteStateProvider.overrideWith((ref) {
          final notifier = InviteNotifier(mockInviteDatasource, ref);
          notifier.state = InviteState(isAccepting: isAccepting, error: error);
          return notifier;
        }),
      ],
    );
  }

  group('ScanInviteScreen', () {
    group('app bar', () {
      testWidgets('shows Scan Invite title', (tester) async {
        await tester.pumpWidget(buildScanInviteScreen());
        await tester.pump();

        expect(find.text('Scan Invite'), findsOneWidget);
      });

      testWidgets('shows Paste/Scan toggle button', (tester) async {
        await tester.pumpWidget(buildScanInviteScreen());
        await tester.pump();

        // Initially shows "Paste" button to switch to paste mode
        expect(find.text('Paste'), findsOneWidget);
      });

      testWidgets('toggle button changes to Scan when in paste mode', (
        tester,
      ) async {
        await tester.pumpWidget(buildScanInviteScreen());
        await tester.pump();

        await tester.tap(find.text('Paste'));
        await tester.pumpAndSettle();

        expect(find.text('Scan'), findsOneWidget);
      });
    });

    group('scanner mode (default)', () {
      testWidgets('shows scanner instructions', (tester) async {
        await tester.pumpWidget(buildScanInviteScreen());
        await tester.pump();

        expect(
          find.text('Scan a QR code to start a conversation'),
          findsOneWidget,
        );
      });

      // Note: MobileScanner widget tests are limited in unit tests
      // as they require camera access. Focus on UI elements.
    });

    group('paste mode', () {
      testWidgets('switches to paste input when Paste tapped', (tester) async {
        await tester.pumpWidget(buildScanInviteScreen());
        await tester.pump();

        await tester.tap(find.text('Paste'));
        await tester.pumpAndSettle();

        expect(find.byType(TextField), findsOneWidget);
        expect(find.text('Invite Link'), findsOneWidget);
      });

      testWidgets('shows paste input hint', (tester) async {
        await tester.pumpWidget(buildScanInviteScreen());
        await tester.pump();

        await tester.tap(find.text('Paste'));
        await tester.pumpAndSettle();

        expect(
          find.text(
            'https://iris.to/invite/... or https://chat.iris.to/#npub...',
          ),
          findsOneWidget,
        );
      });

      testWidgets('shows paste from clipboard button', (tester) async {
        await tester.pumpWidget(buildScanInviteScreen());
        await tester.pump();

        await tester.tap(find.text('Paste'));
        await tester.pumpAndSettle();

        expect(find.byIcon(Icons.paste), findsOneWidget);
      });

      testWidgets('shows Accept Invite button', (tester) async {
        await tester.pumpWidget(buildScanInviteScreen());
        await tester.pump();

        await tester.tap(find.text('Paste'));
        await tester.pumpAndSettle();

        expect(find.text('Accept Invite'), findsOneWidget);
        expect(find.byIcon(Icons.check), findsOneWidget);
      });

      testWidgets('can enter invite URL', (tester) async {
        await tester.pumpWidget(buildScanInviteScreen());
        await tester.pump();

        await tester.tap(find.text('Paste'));
        await tester.pumpAndSettle();

        const testUrl = 'https://iris.to/invite/abc123';
        await tester.enterText(find.byType(TextField), testUrl);
        await tester.pump();

        expect(find.text(testUrl), findsOneWidget);
      });

      testWidgets('shows paste instructions', (tester) async {
        await tester.pumpWidget(buildScanInviteScreen());
        await tester.pump();

        await tester.tap(find.text('Paste'));
        await tester.pumpAndSettle();

        expect(
          find.text('Paste an invite link to start a conversation'),
          findsOneWidget,
        );
      });

      testWidgets('text field supports multiple lines', (tester) async {
        await tester.pumpWidget(buildScanInviteScreen());
        await tester.pump();

        await tester.tap(find.text('Paste'));
        await tester.pumpAndSettle();

        final textField = tester.widget<TextField>(find.byType(TextField));
        expect(textField.maxLines, 3);
      });
    });

    group('processing state', () {
      testWidgets('shows loading indicator when accepting', (tester) async {
        await tester.pumpWidget(buildScanInviteScreen(isAccepting: true));
        await tester.pump();

        expect(find.byType(CircularProgressIndicator), findsOneWidget);
        expect(find.text('Accepting invite...'), findsOneWidget);
      });

      testWidgets('shows processing indicator when accepting', (tester) async {
        await tester.pumpWidget(buildScanInviteScreen(isAccepting: true));
        await tester.pump();

        // Verify the processing indicator and text are shown
        expect(find.byType(CircularProgressIndicator), findsOneWidget);
        expect(find.text('Accepting invite...'), findsOneWidget);
      });
    });

    group('mode switching', () {
      testWidgets('can switch from paste back to scan mode', (tester) async {
        await tester.pumpWidget(buildScanInviteScreen());
        await tester.pump();

        // Switch to paste
        await tester.tap(find.text('Paste'));
        await tester.pumpAndSettle();

        expect(find.byType(TextField), findsOneWidget);

        // Switch back to scan
        await tester.tap(find.text('Scan'));
        await tester.pumpAndSettle();

        expect(find.byType(TextField), findsNothing);
        expect(
          find.text('Scan a QR code to start a conversation'),
          findsOneWidget,
        );
      });
    });

    group('screen structure', () {
      testWidgets('has correct layout with column structure', (tester) async {
        await tester.pumpWidget(buildScanInviteScreen());
        await tester.pump();

        expect(find.byType(Column), findsWidgets);
        expect(find.byType(Scaffold), findsOneWidget);
        expect(find.byType(AppBar), findsOneWidget);
      });

      testWidgets('has expanded area for scanner/input', (tester) async {
        await tester.pumpWidget(buildScanInviteScreen());
        await tester.pump();

        expect(find.byType(Expanded), findsWidgets);
      });

      testWidgets('has safe area for instructions', (tester) async {
        await tester.pumpWidget(buildScanInviteScreen());
        await tester.pump();

        expect(find.byType(SafeArea), findsWidgets);
      });
    });

    group('paste mode input validation', () {
      testWidgets('can enter invite URL in text field', (tester) async {
        await tester.pumpWidget(buildScanInviteScreen());
        await tester.pump();

        await tester.tap(find.text('Paste'));
        await tester.pumpAndSettle();

        const testUrl = 'https://iris.to/invite/test';
        await tester.enterText(find.byType(TextField), testUrl);
        await tester.pump();

        expect(find.text(testUrl), findsOneWidget);
      });

      testWidgets('text field has autocorrect disabled', (tester) async {
        await tester.pumpWidget(buildScanInviteScreen());
        await tester.pump();

        await tester.tap(find.text('Paste'));
        await tester.pumpAndSettle();

        final textField = tester.widget<TextField>(find.byType(TextField));
        expect(textField.autocorrect, isFalse);
      });
    });
  });
}

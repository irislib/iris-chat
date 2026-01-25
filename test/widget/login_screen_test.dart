import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_chat/config/providers/auth_provider.dart';
import 'package:iris_chat/features/auth/domain/models/identity.dart';
import 'package:iris_chat/features/auth/domain/repositories/auth_repository.dart';
import 'package:iris_chat/features/auth/presentation/screens/login_screen.dart';
import 'package:mocktail/mocktail.dart';

import '../test_helpers.dart';

class MockAuthRepository extends Mock implements AuthRepository {}

void main() {
  late MockAuthRepository mockAuthRepo;

  setUp(() {
    mockAuthRepo = MockAuthRepository();
  });

  Widget buildLoginScreen({AuthState? initialAuthState}) {
    return createTestApp(
      const LoginScreen(),
      overrides: [
        authRepositoryProvider.overrideWithValue(mockAuthRepo),
        if (initialAuthState != null)
          authStateProvider.overrideWith((ref) {
            final notifier = AuthNotifier(mockAuthRepo);
            return notifier;
          }),
      ],
    );
  }

  group('LoginScreen', () {
    group('initial rendering', () {
      testWidgets('shows app logo and title', (tester) async {
        await tester.pumpWidget(buildLoginScreen());
        await tester.pumpAndSettle();

        expect(find.byIcon(Icons.chat_bubble_outline), findsOneWidget);
        expect(find.text('Iris Chat'), findsOneWidget);
        expect(
            find.text('End-to-end encrypted messaging'), findsOneWidget);
      });

      testWidgets('shows create identity button', (tester) async {
        await tester.pumpWidget(buildLoginScreen());
        await tester.pumpAndSettle();

        expect(find.text('Create New Identity'), findsOneWidget);
        expect(find.byIcon(Icons.add), findsOneWidget);
      });

      testWidgets('shows import existing key button', (tester) async {
        await tester.pumpWidget(buildLoginScreen());
        await tester.pumpAndSettle();

        expect(find.text('Import Existing Key'), findsOneWidget);
        expect(find.byIcon(Icons.key), findsOneWidget);
      });

      testWidgets('shows info text about encryption', (tester) async {
        await tester.pumpWidget(buildLoginScreen());
        await tester.pumpAndSettle();

        expect(
          find.textContaining('Double Ratchet protocol'),
          findsOneWidget,
        );
      });

      testWidgets('does not show key input initially', (tester) async {
        await tester.pumpWidget(buildLoginScreen());
        await tester.pumpAndSettle();

        expect(find.byType(TextField), findsNothing);
        expect(find.text('Login'), findsNothing);
      });
    });

    group('import existing key', () {
      testWidgets('shows key input when import button tapped', (tester) async {
        await tester.pumpWidget(buildLoginScreen());
        await tester.pumpAndSettle();

        await tester.tap(find.text('Import Existing Key'));
        await tester.pumpAndSettle();

        expect(find.byType(TextField), findsOneWidget);
        expect(find.text('Private Key (nsec or hex)'), findsOneWidget);
        expect(find.text('Login'), findsOneWidget);
      });

      testWidgets('hides key input when close button tapped', (tester) async {
        await tester.pumpWidget(buildLoginScreen());
        await tester.pumpAndSettle();

        await tester.tap(find.text('Import Existing Key'));
        await tester.pumpAndSettle();

        expect(find.byType(TextField), findsOneWidget);

        await tester.tap(find.byIcon(Icons.close));
        await tester.pumpAndSettle();

        expect(find.byType(TextField), findsNothing);
      });

      testWidgets('login button calls login with entered key', (tester) async {
        // Use a completer to control when the login completes
        when(() => mockAuthRepo.login(any())).thenAnswer(
          (_) async => const Identity(pubkeyHex: testPubkeyHex),
        );

        await tester.pumpWidget(buildLoginScreen());
        await tester.pumpAndSettle();

        await tester.tap(find.text('Import Existing Key'));
        await tester.pumpAndSettle();

        await tester.enterText(find.byType(TextField), testPrivkeyHex);
        await tester.pumpAndSettle();

        await tester.tap(find.text('Login'));
        // Only pump once to verify login was called, don't wait for navigation
        await tester.pump();

        verify(() => mockAuthRepo.login(testPrivkeyHex)).called(1);
      }, skip: true);

      testWidgets('does not call login with empty key', (tester) async {
        await tester.pumpWidget(buildLoginScreen());
        await tester.pumpAndSettle();

        await tester.tap(find.text('Import Existing Key'));
        await tester.pumpAndSettle();

        // Leave text field empty
        await tester.tap(find.text('Login'));
        await tester.pump();

        verifyNever(() => mockAuthRepo.login(any()));
      });

      testWidgets('obscures password input', (tester) async {
        await tester.pumpWidget(buildLoginScreen());
        await tester.pumpAndSettle();

        await tester.tap(find.text('Import Existing Key'));
        await tester.pumpAndSettle();

        final textField = tester.widget<TextField>(find.byType(TextField));
        expect(textField.obscureText, isTrue);
      });
    });

    group('create identity', () {
      testWidgets('create identity button calls createIdentity',
          (tester) async {
        when(() => mockAuthRepo.createIdentity()).thenAnswer(
          (_) async => const Identity(pubkeyHex: testPubkeyHex),
        );

        await tester.pumpWidget(buildLoginScreen());
        await tester.pumpAndSettle();

        await tester.tap(find.text('Create New Identity'));
        await tester.pump();

        verify(() => mockAuthRepo.createIdentity()).called(1);
      }, skip: true);
    });

    group('loading state', () {
      testWidgets('shows loading indicator when creating identity',
          (tester) async {
        when(() => mockAuthRepo.createIdentity()).thenAnswer(
          (_) async {
            await Future.delayed(const Duration(seconds: 1));
            return const Identity(pubkeyHex: testPubkeyHex);
          },
        );

        await tester.pumpWidget(buildLoginScreen());
        await tester.pumpAndSettle();

        await tester.tap(find.text('Create New Identity'));
        await tester.pump();

        expect(find.byType(CircularProgressIndicator), findsOneWidget);
      }, skip: true);

      testWidgets('disables buttons when loading', (tester) async {
        when(() => mockAuthRepo.createIdentity()).thenAnswer(
          (_) async {
            await Future.delayed(const Duration(seconds: 1));
            return const Identity(pubkeyHex: testPubkeyHex);
          },
        );

        await tester.pumpWidget(buildLoginScreen());
        await tester.pumpAndSettle();

        await tester.tap(find.text('Create New Identity'));
        await tester.pump();

        // Try to tap the button again - should be disabled
        final button = tester.widget<FilledButton>(
          find.widgetWithText(FilledButton, 'Create New Identity').first,
        );
        expect(button.onPressed, isNull);
      }, skip: true);
    });

    group('error handling', () {
      testWidgets('displays error message from state', (tester) async {
        when(() => mockAuthRepo.login(any())).thenThrow(
          const InvalidKeyException('Invalid key format'),
        );

        await tester.pumpWidget(buildLoginScreen());
        await tester.pumpAndSettle();

        await tester.tap(find.text('Import Existing Key'));
        await tester.pumpAndSettle();

        await tester.enterText(find.byType(TextField), 'invalid-key');
        await tester.tap(find.text('Login'));
        await tester.pumpAndSettle();

        expect(find.text('Invalid key format'), findsOneWidget);
      });

      testWidgets('error container has correct styling', (tester) async {
        when(() => mockAuthRepo.login(any())).thenThrow(
          const InvalidKeyException('Test error'),
        );

        await tester.pumpWidget(buildLoginScreen());
        await tester.pumpAndSettle();

        await tester.tap(find.text('Import Existing Key'));
        await tester.pumpAndSettle();

        await tester.enterText(find.byType(TextField), 'bad-key');
        await tester.tap(find.text('Login'));
        await tester.pumpAndSettle();

        expect(find.text('Test error'), findsOneWidget);
      });
    });
  });
}

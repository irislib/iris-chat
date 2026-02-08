import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/auth/presentation/screens/link_device_screen.dart';
import '../features/auth/presentation/screens/login_screen.dart';
import '../features/chat/presentation/screens/chat_list_screen.dart';
import '../features/chat/presentation/screens/chat_screen.dart';
import '../features/chat/presentation/screens/create_group_screen.dart';
import '../features/chat/presentation/screens/group_chat_screen.dart';
import '../features/chat/presentation/screens/group_info_screen.dart';
import '../features/chat/presentation/screens/new_chat_screen.dart';
import '../features/invite/presentation/screens/create_invite_screen.dart';
import '../features/invite/presentation/screens/scan_invite_screen.dart';
import '../features/settings/presentation/screens/settings_screen.dart';
import 'providers/auth_provider.dart';

final routerProvider = Provider<GoRouter>((ref) {
  final authState = ref.watch(authStateProvider);

  // Trigger auth check on first access
  if (!authState.isInitialized && !authState.isLoading) {
    Future.microtask(() {
      ref.read(authStateProvider.notifier).checkAuth();
    });
  }

  return GoRouter(
    initialLocation: '/',
    redirect: (context, state) {
      // Show nothing while checking auth
      if (!authState.isInitialized) {
        return null;
      }

      final isAuthenticated = authState.isAuthenticated;
      final isAuthRoute =
          state.matchedLocation == '/login' || state.matchedLocation == '/link';

      if (!isAuthenticated && !isAuthRoute) {
        return '/login';
      }
      if (isAuthenticated && isAuthRoute) {
        return '/chats';
      }
      return null;
    },
    routes: [
      GoRoute(
        path: '/login',
        builder: (context, state) => const LoginScreen(),
      ),
      GoRoute(
        path: '/link',
        builder: (context, state) => const LinkDeviceScreen(),
      ),
      GoRoute(
        path: '/',
        builder: (context, state) {
          // Show loading while checking auth
          if (!authState.isInitialized) {
            return const Scaffold(
              body: Center(child: CircularProgressIndicator()),
            );
          }
          return const SizedBox.shrink(); // Will redirect
        },
        redirect: (context, state) {
          if (!authState.isInitialized) return null;
          return '/chats';
        },
      ),
      GoRoute(
        path: '/chats',
        builder: (context, state) => const ChatListScreen(),
        routes: [
          GoRoute(
            path: 'new',
            builder: (context, state) => const NewChatScreen(),
          ),
          GoRoute(
            path: ':id',
            builder: (context, state) => ChatScreen(
              sessionId: state.pathParameters['id']!,
            ),
          ),
        ],
      ),
      GoRoute(
        path: '/invite/create',
        builder: (context, state) => const CreateInviteScreen(),
      ),
      GoRoute(
        path: '/invite/scan',
        builder: (context, state) => const ScanInviteScreen(),
      ),
      GoRoute(
        path: '/groups/new',
        builder: (context, state) => const CreateGroupScreen(),
      ),
      GoRoute(
        path: '/groups/:id',
        builder: (context, state) => GroupChatScreen(
          groupId: state.pathParameters['id']!,
        ),
        routes: [
          GoRoute(
            path: 'info',
            builder: (context, state) => GroupInfoScreen(
              groupId: state.pathParameters['id']!,
            ),
          ),
        ],
      ),
      GoRoute(
        path: '/settings',
        builder: (context, state) => const SettingsScreen(),
      ),
    ],
    errorBuilder: (context, state) => Scaffold(
      body: Center(
        child: Text('Page not found: ${state.matchedLocation}'),
      ),
    ),
  );
});

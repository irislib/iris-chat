import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../config/providers/auth_provider.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _keyController = TextEditingController();
  bool _showKeyInput = false;

  @override
  void dispose() {
    _keyController.dispose();
    super.dispose();
  }

  Future<void> _createIdentity() async {
    await ref.read(authStateProvider.notifier).createIdentity();
    if (mounted) {
      final state = ref.read(authStateProvider);
      if (state.isAuthenticated) {
        context.go('/chats');
      }
    }
  }

  Future<void> _login() async {
    final key = _keyController.text.trim();
    if (key.isEmpty) return;

    await ref.read(authStateProvider.notifier).login(key);
    if (mounted) {
      final state = ref.read(authStateProvider);
      if (state.isAuthenticated) {
        context.go('/chats');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authStateProvider);
    final theme = Theme.of(context);

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Spacer(),
              // Logo/Title
              Icon(
                Icons.chat_bubble_outline,
                size: 80,
                color: theme.colorScheme.primary,
              ),
              const SizedBox(height: 24),
              Text(
                'Iris',
                style: theme.textTheme.headlineLarge?.copyWith(
                  fontWeight: FontWeight.bold,
                ),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 48),

              // Error message
              if (authState.error != null) ...[
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: theme.colorScheme.errorContainer,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(
                    authState.error!,
                    style: TextStyle(color: theme.colorScheme.onErrorContainer),
                    textAlign: TextAlign.center,
                  ),
                ),
                const SizedBox(height: 16),
              ],

              // Key input (if showing)
              if (_showKeyInput) ...[
                TextField(
                  controller: _keyController,
                  decoration: InputDecoration(
                    labelText: 'Private Key (nsec or hex)',
                    hintText: 'Enter your private key',
                    border: const OutlineInputBorder(),
                    suffixIcon: IconButton(
                      icon: const Icon(Icons.close),
                      onPressed: () {
                        setState(() {
                          _showKeyInput = false;
                          _keyController.clear();
                        });
                        ref.read(authStateProvider.notifier).clearError();
                      },
                    ),
                  ),
                  obscureText: true,
                  autocorrect: false,
                  enableSuggestions: false,
                ),
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: authState.isLoading ? null : _login,
                  child: authState.isLoading
                      ? const SizedBox(
                          height: 20,
                          width: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('Login'),
                ),
              ] else ...[
                // Create new identity button
                FilledButton.icon(
                  onPressed: authState.isLoading ? null : _createIdentity,
                  icon: const Icon(Icons.add),
                  label: authState.isLoading
                      ? const SizedBox(
                          height: 20,
                          width: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('Create New Identity'),
                ),
                const SizedBox(height: 12),
                // Import existing key button
                OutlinedButton.icon(
                  onPressed: authState.isLoading
                      ? null
                      : () => setState(() => _showKeyInput = true),
                  icon: const Icon(Icons.key),
                  label: const Text('Import Existing Key'),
                ),
              ],
              const Spacer(),
            ],
          ),
        ),
      ),
    );
  }
}

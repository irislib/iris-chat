import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:iris_chat/config/providers/auth_provider.dart';
import 'package:iris_chat/config/providers/chat_provider.dart';
import 'package:iris_chat/core/services/profile_service.dart';
import 'package:iris_chat/core/services/session_manager_service.dart';
import 'package:iris_chat/features/auth/domain/repositories/auth_repository.dart';
import 'package:iris_chat/features/chat/data/datasources/group_local_datasource.dart';
import 'package:iris_chat/features/chat/data/datasources/group_message_local_datasource.dart';
import 'package:iris_chat/features/chat/data/datasources/session_local_datasource.dart';
import 'package:iris_chat/features/chat/domain/models/group.dart';
import 'package:iris_chat/features/chat/domain/models/session.dart';
import 'package:iris_chat/features/chat/presentation/screens/group_info_screen.dart';
import 'package:iris_chat/shared/utils/formatters.dart';
import 'package:mocktail/mocktail.dart';

import '../test_helpers.dart';

class _MockAuthRepository extends Mock implements AuthRepository {}

class _MockSessionLocalDatasource extends Mock implements SessionLocalDatasource {}

class _MockProfileService extends Mock implements ProfileService {}

class _MockGroupLocalDatasource extends Mock implements GroupLocalDatasource {}

class _MockGroupMessageLocalDatasource extends Mock
    implements GroupMessageLocalDatasource {}

class _MockSessionManagerService extends Mock implements SessionManagerService {}

class _TestGroupNotifier extends GroupNotifier {
  _TestGroupNotifier(ChatGroup group)
      : super(
          _MockGroupLocalDatasource(),
          _MockGroupMessageLocalDatasource(),
          _MockSessionManagerService(),
        ) {
    state = GroupState(groups: [group], isLoading: false);
  }

  int addMembersCalls = 0;
  int removeMemberCalls = 0;
  int renameCalls = 0;

  @override
  Future<void> loadGroups() async {
    // No-op for widget tests.
  }

  @override
  Future<void> renameGroup(String groupId, String name) async {
    renameCalls++;
    final trimmed = name.trim();
    if (trimmed.isEmpty) return;
    state = state.copyWith(
      groups: state.groups
          .map((g) => g.id == groupId ? g.copyWith(name: trimmed) : g)
          .toList(),
    );
  }

  @override
  Future<void> addGroupMembers(String groupId, List<String> memberPubkeysHex) async {
    addMembersCalls++;
    final next = <ChatGroup>[];
    for (final g in state.groups) {
      if (g.id != groupId) {
        next.add(g);
        continue;
      }
      final members = [...g.members];
      for (final pk in memberPubkeysHex) {
        if (!members.contains(pk)) members.add(pk);
      }
      next.add(g.copyWith(members: members));
    }
    state = state.copyWith(groups: next);
  }

  @override
  Future<void> removeGroupMember(String groupId, String memberPubkeyHex) async {
    removeMemberCalls++;
    state = state.copyWith(
      groups: state.groups
          .map(
            (g) => g.id == groupId
                ? g.copyWith(
                    members: g.members.where((m) => m != memberPubkeyHex).toList(),
                    admins: g.admins.where((a) => a != memberPubkeyHex).toList(),
                  )
                : g,
          )
          .toList(),
    );
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const otherPubkeyHex =
      'b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b3';
  const newMemberPubkeyHex =
      'c1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b4';

  ChatGroup makeGroup({required List<String> admins}) {
    return ChatGroup(
      id: 'g1',
      name: 'Test Group',
      members: [testPubkeyHex, otherPubkeyHex],
      admins: admins,
      createdAt: DateTime(2026, 1, 1),
      accepted: true,
    );
  }

  testWidgets('admin can edit group members', (tester) async {
    final mockAuthRepo = _MockAuthRepository();
    final mockSessions = _MockSessionLocalDatasource();
    final mockProfiles = _MockProfileService();

    late _TestGroupNotifier groupNotifier;

    await tester.pumpWidget(
      createTestApp(
        const GroupInfoScreen(groupId: 'g1'),
        overrides: [
          authRepositoryProvider.overrideWithValue(mockAuthRepo),
          authStateProvider.overrideWith((ref) {
            final notifier = AuthNotifier(mockAuthRepo);
            notifier.state = const AuthState(
              isAuthenticated: true,
              pubkeyHex: testPubkeyHex,
              devicePubkeyHex: testPubkeyHex,
              isInitialized: true,
            );
            return notifier;
          }),
          sessionStateProvider.overrideWith((ref) {
            final notifier = SessionNotifier(mockSessions, mockProfiles);
            notifier.state = SessionState(
              sessions: [
                ChatSession(
                  id: newMemberPubkeyHex,
                  recipientPubkeyHex: newMemberPubkeyHex,
                  recipientName: 'Alice',
                  createdAt: DateTime(2026, 1, 1),
                ),
              ],
            );
            return notifier;
          }),
          groupStateProvider.overrideWith((ref) {
            groupNotifier = _TestGroupNotifier(makeGroup(admins: [testPubkeyHex]));
            return groupNotifier;
          }),
        ],
      ),
    );

    await tester.pumpAndSettle();

    expect(find.text('Members'), findsOneWidget);
    expect(find.byIcon(Icons.edit), findsOneWidget);

    // Existing members are visible.
    expect(find.text(formatPubkeyForDisplay(testPubkeyHex)), findsOneWidget);
    expect(find.text(formatPubkeyForDisplay(otherPubkeyHex)), findsOneWidget);

    // Can remove other member (but not self).
    expect(find.byIcon(Icons.remove_circle_outline), findsOneWidget);

    // Add section shows candidates from existing 1:1 chats.
    expect(find.text('Add Members'), findsOneWidget);
    expect(find.text('Alice'), findsOneWidget);

    await tester.tap(find.byType(CheckboxListTile));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Add Selected'));
    await tester.pumpAndSettle();

    expect(groupNotifier.addMembersCalls, 1);
    expect(find.text(formatPubkeyForDisplay(newMemberPubkeyHex)), findsOneWidget);
  });

  testWidgets('non-admin cannot edit group members', (tester) async {
    final mockAuthRepo = _MockAuthRepository();
    final mockSessions = _MockSessionLocalDatasource();
    final mockProfiles = _MockProfileService();

    await tester.pumpWidget(
      createTestApp(
        const GroupInfoScreen(groupId: 'g1'),
        overrides: [
          authRepositoryProvider.overrideWithValue(mockAuthRepo),
          authStateProvider.overrideWith((ref) {
            final notifier = AuthNotifier(mockAuthRepo);
            notifier.state = const AuthState(
              isAuthenticated: true,
              pubkeyHex: testPubkeyHex,
              devicePubkeyHex: testPubkeyHex,
              isInitialized: true,
            );
            return notifier;
          }),
          sessionStateProvider.overrideWith((ref) {
            final notifier = SessionNotifier(mockSessions, mockProfiles);
            notifier.state = const SessionState(sessions: []);
            return notifier;
          }),
          groupStateProvider.overrideWith((ref) {
            return _TestGroupNotifier(makeGroup(admins: [otherPubkeyHex]));
          }),
        ],
      ),
    );

    await tester.pumpAndSettle();

    expect(find.text('Members'), findsOneWidget);
    expect(find.byIcon(Icons.edit), findsNothing);
    expect(find.byIcon(Icons.remove_circle_outline), findsNothing);
    expect(find.text('Add Members'), findsNothing);
    expect(find.text('Add Selected'), findsNothing);
  });
}

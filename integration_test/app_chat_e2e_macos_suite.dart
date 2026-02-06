import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:iris_chat/config/providers/auth_provider.dart';
import 'package:iris_chat/config/providers/chat_provider.dart';
import 'package:iris_chat/config/providers/invite_provider.dart';
import 'package:iris_chat/config/providers/nostr_provider.dart';
import 'package:iris_chat/core/services/database_service.dart';
import 'package:iris_chat/core/services/nostr_service.dart';
import 'package:iris_chat/core/services/secure_storage_service.dart';
import 'package:iris_chat/core/services/session_manager_service.dart';
import 'package:iris_chat/core/utils/invite_url.dart';
import 'package:mocktail/mocktail.dart';

import 'test_relay.dart';

class _MockFlutterSecureStorage extends Mock implements FlutterSecureStorage {}

SecureStorageService _createInMemorySecureStorage() {
  final store = <String, String?>{};
  final storage = _MockFlutterSecureStorage();

  when(
    () => storage.write(
      key: any(named: 'key'),
      value: any(named: 'value'),
    ),
  ).thenAnswer((invocation) async {
    final key = invocation.namedArguments[#key] as String;
    final value = invocation.namedArguments[#value] as String?;
    store[key] = value;
  });

  when(() => storage.read(key: any(named: 'key'))).thenAnswer((
    invocation,
  ) async {
    final key = invocation.namedArguments[#key] as String;
    return store[key];
  });

  when(() => storage.containsKey(key: any(named: 'key'))).thenAnswer((
    invocation,
  ) async {
    final key = invocation.namedArguments[#key] as String;
    return store.containsKey(key);
  });

  when(() => storage.delete(key: any(named: 'key'))).thenAnswer((
    invocation,
  ) async {
    final key = invocation.namedArguments[#key] as String;
    store.remove(key);
  });

  Future<void> clearAll(Invocation _) async => store.clear();
  when(storage.deleteAll).thenAnswer(clearAll);

  return SecureStorageService(storage);
}

class _AppInstance {
  _AppInstance({
    required this.name,
    required this.container,
    required this.rootDir,
  });

  final String name;
  final ProviderContainer container;
  final Directory rootDir;

  String get dbPath => '${rootDir.path}/db.sqlite';
  String get ndrPath => '${rootDir.path}/ndr';

  Future<void> dispose() async {
    // Best-effort cleanup; test failures should still unwind.
    try {
      await container.read(sessionManagerServiceProvider).dispose();
    } catch (_) {}
    try {
      await container.read(nostrServiceProvider).dispose();
    } catch (_) {}
    try {
      await container.read(databaseServiceProvider).close();
    } catch (_) {}
    container.dispose();
    try {
      await rootDir.delete(recursive: true);
    } catch (_) {}
  }
}

ProviderContainer _makeContainer({
  required String relayUrl,
  required String dbPath,
  required String ndrPath,
  required SecureStorageService secureStorage,
}) {
  return ProviderContainer(
    overrides: [
      secureStorageProvider.overrideWithValue(secureStorage),
      databaseServiceProvider.overrideWithValue(
        DatabaseService(dbPath: dbPath),
      ),
      nostrServiceProvider.overrideWith((ref) {
        final service = NostrService(relayUrls: [relayUrl]);
        ref.onDispose(() {
          // onDispose doesn't await; keep it best-effort.
          unawaited(service.dispose());
        });
        return service;
      }),
      sessionManagerServiceProvider.overrideWith((ref) {
        final nostr = ref.watch(nostrServiceProvider);
        final sessions = ref.watch(sessionDatasourceProvider);
        final auth = ref.watch(authRepositoryProvider);

        final svc = SessionManagerService(
          nostr,
          sessions,
          auth,
          storagePathOverride: ndrPath,
        );
        unawaited(svc.start());
        ref.onDispose(() {
          unawaited(svc.dispose());
        });
        return svc;
      }),
    ],
  );
}

Future<_AppInstance> _startInstance({
  required String name,
  required String relayUrl,
}) async {
  final rootDir = await Directory.systemTemp.createTemp('iris-chat-$name-');
  final secureStorage = _createInMemorySecureStorage();

  final container = _makeContainer(
    relayUrl: relayUrl,
    dbPath: '${rootDir.path}/db.sqlite',
    ndrPath: '${rootDir.path}/ndr',
    secureStorage: secureStorage,
  );

  // Create identity before starting the session manager.
  await container.read(authStateProvider.notifier).createIdentity();

  // Bring transport online.
  await container.read(nostrServiceProvider).connect();

  // Start message + invite subscription bridge.
  container.read(messageSubscriptionProvider);

  return _AppInstance(name: name, container: container, rootDir: rootDir);
}

Future<void> _pumpUntil({
  required bool Function() condition,
  Duration timeout = const Duration(seconds: 12),
  Duration delay = const Duration(milliseconds: 25),
  String Function()? debugOnTimeout,
}) async {
  final end = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(end)) {
    if (condition()) return;
    await Future.delayed(delay);
  }
  final extra = debugOnTimeout != null ? '\n${debugOnTimeout()}' : '';
  throw StateError(
    'pumpUntil: condition not met after ${timeout.inSeconds}s$extra',
  );
}

bool _eventHasTag(Map<String, dynamic> event, String name, String value) {
  final tags = event['tags'];
  if (tags is! List) return false;
  for (final t in tags) {
    if (t is! List || t.length < 2) continue;
    if (t[0] == name && t[1] == value) return true;
  }
  return false;
}

String _describeChatState(ProviderContainer c) {
  final sb = StringBuffer();

  final sessions = c.read(sessionStateProvider).sessions;
  sb.writeln('sessions(${sessions.length}):');
  for (final s in sessions) {
    final pk = s.recipientPubkeyHex;
    final pk8 = pk.length >= 8 ? pk.substring(0, 8) : pk;
    sb.writeln(
      '  id=${s.id} recipient=$pk8 initiator=${s.isInitiator} unread=${s.unreadCount} lastPreview="${s.lastMessagePreview ?? ""}"',
    );
  }

  final chat = c.read(chatStateProvider);
  sb.writeln('chat messages keys(${chat.messages.length}):');
  for (final entry in chat.messages.entries) {
    final sid = entry.key;
    final msgs = entry.value;
    sb.writeln('  sessionId=$sid msgs=${msgs.length}');
    for (final m in msgs) {
      sb.writeln(
        '    ${m.isIncoming ? "in " : "out"} ${m.status.name} text="${m.text}"',
      );
    }
  }

  return sb.toString();
}

String _describeRelayDrEvents(TestRelay relay) {
  final sb = StringBuffer();
  final dr = relay.events.where((e) {
    final k = e['kind'];
    return k is num && k.toInt() == 1060;
  }).toList();

  sb.writeln('relay kind=1060 events(${dr.length}):');
  for (final e in dr) {
    final id = e['id']?.toString() ?? 'null';
    final id8 = id.length >= 8 ? id.substring(0, 8) : id;
    final pubkey = e['pubkey']?.toString() ?? 'null';
    final pk8 = pubkey.length >= 8 ? pubkey.substring(0, 8) : pubkey;
    final tags = e['tags'];
    String? p;
    if (tags is List) {
      for (final t in tags) {
        if (t is! List || t.length < 2) continue;
        if (t[0] == 'p') {
          p = t[1]?.toString();
          break;
        }
      }
    }
    final p8 = p == null ? 'null' : (p.length >= 8 ? p.substring(0, 8) : p);
    sb.writeln('  id=$id8 pubkey=$pk8 p=$p8');
  }
  return sb.toString();
}

String _describeDecryptedMessage(DecryptedMessage m) {
  var innerKind = 'non-json';
  var innerContent = '';

  try {
    final decoded = jsonDecode(m.content);
    if (decoded is Map<String, dynamic>) {
      innerKind = decoded['kind']?.toString() ?? 'null';
      innerContent = (decoded['content'] ?? '').toString();
    } else {
      innerKind = 'non-map-json';
      innerContent = decoded.toString();
    }
  } catch (_) {
    innerKind = 'non-json';
    innerContent = m.content;
  }

  final sender = m.senderPubkeyHex;
  final sender8 = sender.length >= 8 ? sender.substring(0, 8) : sender;
  final eventId = m.eventId ?? '';
  final event8 = eventId.length >= 8 ? eventId.substring(0, 8) : eventId;
  final contentPreview =
      innerContent.length > 80 ? '${innerContent.substring(0, 80)}...' : innerContent;
  return 'from=$sender8 eventId=$event8 kind=$innerKind content="$contentPreview"';
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('two app instances can exchange messages over a relay', (
    tester,
  ) async {
    await tester.pumpWidget(const SizedBox.shrink());

    if (!Platform.isMacOS) {
      return;
    }

    final relay = await TestRelay.start();
    final relayUrl = 'ws://127.0.0.1:${relay.port}';

    _AppInstance? alice;
    _AppInstance? bob;

    final aliceDec = <String>[];
    final bobDec = <String>[];
    StreamSubscription<DecryptedMessage>? aliceDecSub;
    StreamSubscription<DecryptedMessage>? bobDecSub;
    final aliceNostr1060 = <String>[];
    final bobNostr1060 = <String>[];
    StreamSubscription? aliceNostrSub;
    StreamSubscription? bobNostrSub;

    try {
      alice = await _startInstance(name: 'alice', relayUrl: relayUrl);
      bob = await _startInstance(name: 'bob', relayUrl: relayUrl);

      final aliceC = alice.container;
      final bobC = bob.container;

      aliceDecSub = aliceC
          .read(sessionManagerServiceProvider)
          .decryptedMessages
          .listen((m) {
            aliceDec.add(_describeDecryptedMessage(m));
            if (aliceDec.length > 50) {
              aliceDec.removeAt(0);
            }
          });
      bobDecSub = bobC
          .read(sessionManagerServiceProvider)
          .decryptedMessages
          .listen((m) {
            bobDec.add(_describeDecryptedMessage(m));
            if (bobDec.length > 50) {
              bobDec.removeAt(0);
            }
          });

      aliceNostrSub = aliceC.read(nostrServiceProvider).events.listen((e) {
        if (e.kind != 1060) return;
        final id8 = e.id.length >= 8 ? e.id.substring(0, 8) : e.id;
        aliceNostr1060.add('id=$id8 sub=${e.subscriptionId ?? ""}');
        if (aliceNostr1060.length > 50) {
          aliceNostr1060.removeAt(0);
        }
      });
      bobNostrSub = bobC.read(nostrServiceProvider).events.listen((e) {
        if (e.kind != 1060) return;
        final id8 = e.id.length >= 8 ? e.id.substring(0, 8) : e.id;
        bobNostr1060.add('id=$id8 sub=${e.subscriptionId ?? ""}');
        if (bobNostr1060.length > 50) {
          bobNostr1060.removeAt(0);
        }
      });

      // Alice creates invite.
      final invite = await aliceC
          .read(inviteStateProvider.notifier)
          .createInvite(maxUses: 1);
      expect(invite, isNotNull);

      final inviteUrl = await aliceC
          .read(inviteStateProvider.notifier)
          .getInviteUrl(invite!.id);
      expect(inviteUrl, isNotNull);

      final data = decodeInviteUrlData(inviteUrl!);
      final eph =
          data?['ephemeralKey'] ??
          data?['inviterEphemeralPublicKey'] ??
          data?['inviterEphemeralPublicKeyHex'];
      final inviteEph = eph is String ? eph : eph?.toString();
      expect(inviteEph, isNotNull, reason: 'Invite URL missing ephemeral key');

      // Ensure at least one client is subscribed for the invite response before Bob publishes it.
      await _pumpUntil(
        condition: () =>
            relay.hasKindAndPTagSubscription(kind: 1059, pTagValue: inviteEph!),
        timeout: const Duration(seconds: 6),
      );

      // Bob accepts.
      final bobSessionId = await bobC
          .read(inviteStateProvider.notifier)
          .acceptInviteFromUrl(inviteUrl);
      expect(bobSessionId, isNotNull);

      final taggedInviteResponses = relay.events.where((e) {
        final k = e['kind'];
        return k is num &&
            k.toInt() == 1059 &&
            _eventHasTag(e, 'p', inviteEph!);
      });
      expect(
        taggedInviteResponses,
        isNotEmpty,
        reason: 'Relay did not receive invite response for invite eph',
      );

      final bobOwnerPubkey = bobC.read(authStateProvider).pubkeyHex;
      expect(bobOwnerPubkey, isNotNull);

      // Wait for Alice to process the invite response and create a session.
      await _pumpUntil(
        condition: () {
          final sessions = aliceC.read(sessionStateProvider).sessions;
          return sessions.any((s) => s.recipientPubkeyHex == bobOwnerPubkey);
        },
      );

      final aliceSession = aliceC
          .read(sessionStateProvider)
          .sessions
          .firstWhere((s) => s.recipientPubkeyHex == bobOwnerPubkey);

      // Bob -> Alice
      await bobC
          .read(chatStateProvider.notifier)
          .sendMessage(bobSessionId!, 'hello alice');

      await _pumpUntil(
        condition: () {
          final msgs =
              aliceC.read(chatStateProvider).messages[aliceSession.id] ??
              const [];
          return msgs.any((m) => m.text == 'hello alice' && m.isIncoming);
        },
      );

      // Alice -> Bob
      await aliceC
          .read(chatStateProvider.notifier)
          .sendMessage(aliceSession.id, 'hi bob');

      await _pumpUntil(
        condition: () {
          final msgs =
              bobC.read(chatStateProvider).messages[bobSessionId] ?? const [];
          return msgs.any((m) => m.text == 'hi bob' && m.isIncoming);
        },
        debugOnTimeout: () {
          return '--- bob state ---\n${_describeChatState(bobC)}\n'
              '--- alice state ---\n${_describeChatState(aliceC)}\n'
              '--- bob decrypted (${bobDec.length}) ---\n${bobDec.join("\n")}\n'
              '--- alice decrypted (${aliceDec.length}) ---\n${aliceDec.join("\n")}\n'
              '--- bob nostr 1060 (${bobNostr1060.length}) ---\n${bobNostr1060.join("\n")}\n'
              '--- alice nostr 1060 (${aliceNostr1060.length}) ---\n${aliceNostr1060.join("\n")}\n'
              '--- relay ---\n${_describeRelayDrEvents(relay)}';
        },
      );
    } finally {
      // Cancel local decrypted-message taps (best effort).
      try {
        await aliceDecSub?.cancel();
      } catch (_) {}
      try {
        await bobDecSub?.cancel();
      } catch (_) {}
      try {
        await aliceNostrSub?.cancel();
      } catch (_) {}
      try {
        await bobNostrSub?.cancel();
      } catch (_) {}
      await alice?.dispose();
      await bob?.dispose();
      await relay.stop();
    }
  });
}

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:iris_chat/core/ffi/ndr_ffi.dart';
import 'package:iris_chat/core/services/nostr_service.dart';
import 'package:iris_chat/core/services/secure_storage_service.dart';
import 'package:iris_chat/core/utils/invite_url.dart';
import 'package:iris_chat/core/utils/nostr_rumor.dart';
import 'package:iris_chat/features/auth/data/repositories/auth_repository_impl.dart';
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

class _Harness {
  _Harness({required this.manager, required this.nostr});

  final SessionManagerHandle manager;
  final NostrService nostr;
  final List<NostrEvent> inbound = <NostrEvent>[];
  final List<PubSubEvent> decrypted = <PubSubEvent>[];
  final List<Map<String, dynamic>> publishedEvents = <Map<String, dynamic>>[];
  final List<Map<String, dynamic>> subscribeFilters = <Map<String, dynamic>>[];

  StreamSubscription<NostrEvent>? _sub;

  void start() {
    _sub ??= nostr.events.listen(inbound.add);
  }

  Future<void> stop() async {
    await _sub?.cancel();
    _sub = null;
  }

  List<NostrEvent> drainInbound() {
    if (inbound.isEmpty) return const <NostrEvent>[];
    final out = List<NostrEvent>.from(inbound);
    inbound.clear();
    return out;
  }

  Future<List<PubSubEvent>> drainAndBridge() async {
    final events = await manager.drainEvents();
    for (final e in events) {
      switch (e.kind) {
        case 'publish':
        case 'publish_signed':
          final ej = e.eventJson;
          if (ej != null) {
            try {
              final m = jsonDecode(ej) as Map<String, dynamic>;
              publishedEvents.add(m);
            } catch (_) {}
            await nostr.publishEvent(ej);
          }
          break;
        case 'subscribe':
          if (e.subid == null || e.filterJson == null) break;
          final m = jsonDecode(e.filterJson!) as Map<String, dynamic>;
          subscribeFilters.add(m);
          nostr.subscribeWithIdRaw(e.subid!, m);
          break;
        case 'unsubscribe':
          if (e.subid != null) nostr.closeSubscription(e.subid!);
          break;
        case 'decrypted_message':
          decrypted.add(e);
          break;
      }
    }
    return events;
  }
}

NostrRumor? _findRumor(List<PubSubEvent> decrypted, {required String content}) {
  for (final e in decrypted) {
    if (e.kind != 'decrypted_message') continue;
    final c = e.content;
    if (c == null) continue;
    final rumor = NostrRumor.tryParse(c);
    if (rumor == null) continue;
    if (rumor.kind != 14) continue;
    if (rumor.content == content) return rumor;
  }
  return null;
}

Future<void> _pumpUntil({
  required _Harness a,
  required _Harness b,
  required bool Function() condition,
  int maxRounds = 250,
  Duration delay = const Duration(milliseconds: 20),
}) async {
  var idleRounds = 0;

  for (var i = 0; i < maxRounds; i++) {
    // Drain pubsub queues and bridge to Nostr.
    final aDrain = await a.drainAndBridge();
    final bDrain = await b.drainAndBridge();

    // Deliver inbound Nostr events to the session managers.
    final aIn = a.drainInbound();
    final bIn = b.drainInbound();
    for (final e in aIn) {
      await a.manager.processEvent(jsonEncode(e.toJson()));
    }
    for (final e in bIn) {
      await b.manager.processEvent(jsonEncode(e.toJson()));
    }

    if (condition()) return;

    final progressed =
        aDrain.isNotEmpty ||
        bDrain.isNotEmpty ||
        aIn.isNotEmpty ||
        bIn.isNotEmpty;
    if (!progressed) {
      idleRounds++;
      if (idleRounds >= 10) {
        await Future.delayed(delay);
      }
    } else {
      idleRounds = 0;
      await Future.delayed(delay);
    }
  }

  throw StateError('pumpUntil: condition not met after $maxRounds rounds');
}

Future<void> _pumpRounds({
  required _Harness a,
  required _Harness b,
  int rounds = 20,
  Duration delay = const Duration(milliseconds: 20),
}) async {
  for (var i = 0; i < rounds; i++) {
    await a.drainAndBridge();
    await b.drainAndBridge();

    final aIn = a.drainInbound();
    final bIn = b.drainInbound();

    for (final e in aIn) {
      await a.manager.processEvent(jsonEncode(e.toJson()));
    }
    for (final e in bIn) {
      await b.manager.processEvent(jsonEncode(e.toJson()));
    }

    await Future.delayed(delay);
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'two instances: relay roundtrip + reconnect (subscribe before connect)',
    (tester) async {
      await tester.pumpWidget(const SizedBox.shrink());

      if (!Platform.isMacOS) {
        return;
      }

      final relay = await TestRelay.start();
      final url = 'ws://127.0.0.1:${relay.port}';

      final aliceNostr = NostrService(relayUrls: [url]);
      final bobNostr = NostrService(relayUrls: [url]);

      final alice = await NdrFfi.generateKeypair();
      final bob = await NdrFfi.generateKeypair();

      final aliceDir = await Directory.systemTemp.createTemp(
        'ndr-relay-alice-',
      );
      final bobDir = await Directory.systemTemp.createTemp('ndr-relay-bob-');

      final aliceMgr = await NdrFfi.createSessionManager(
        ourPubkeyHex: alice.publicKeyHex,
        ourIdentityPrivkeyHex: alice.privateKeyHex,
        deviceId: alice.publicKeyHex,
        storagePath: aliceDir.path,
      );
      final bobMgr = await NdrFfi.createSessionManager(
        ourPubkeyHex: bob.publicKeyHex,
        ourIdentityPrivkeyHex: bob.privateKeyHex,
        deviceId: bob.publicKeyHex,
        storagePath: bobDir.path,
      );

      final a = _Harness(manager: aliceMgr, nostr: aliceNostr);
      final b = _Harness(manager: bobMgr, nostr: bobNostr);

      try {
        a.start();
        b.start();

        await aliceMgr.init();
        await bobMgr.init();

        // Establish a session state via an invite, then import into both managers.
        final invite = await NdrFfi.createInvite(
          inviterPubkeyHex: alice.publicKeyHex,
          deviceId: alice.publicKeyHex,
          maxUses: 1,
        );
        // Mirror app behavior: embed owner pubkey for multi-device mapping.
        await invite.setOwnerPubkeyHex(alice.publicKeyHex);
        final inviteUrl = await invite.toUrl('https://iris.to');
        final bobInvite = await NdrFfi.inviteFromUrl(inviteUrl);
        final accept = await bobInvite.acceptWithOwner(
          inviteePubkeyHex: bob.publicKeyHex,
          inviteePrivkeyHex: bob.privateKeyHex,
          deviceId: bob.publicKeyHex,
          ownerPubkeyHex: bob.publicKeyHex,
        );
        final resp = await invite.processResponse(
          eventJson: accept.responseEventJson,
          inviterPrivkeyHex: alice.privateKeyHex,
        );
        expect(resp, isNotNull);

        final aliceState = await resp!.session.stateJson();
        final bobState = await accept.session.stateJson();

        await aliceMgr.importSessionState(
          peerPubkeyHex: bob.publicKeyHex,
          stateJson: aliceState,
          deviceId: bob.publicKeyHex,
        );
        await bobMgr.importSessionState(
          peerPubkeyHex: alice.publicKeyHex,
          stateJson: bobState,
          deviceId: alice.publicKeyHex,
        );

        // Drain pubsub while transport is disconnected: NostrService should remember
        // subscriptions and replay them when we connect.
        await _pumpRounds(a: a, b: b, rounds: 30);

        await aliceNostr.connect();
        await bobNostr.connect();

        // Give the transport time to replay subscriptions and flush queued publishes.
        await _pumpRounds(a: a, b: b, rounds: 30);

        // Initiator must send first (Bob accepted Alice's invite).
        final send1 = await bobMgr.sendTextWithInnerId(
          recipientPubkeyHex: alice.publicKeyHex,
          text: 'hello over relay',
        );
        expect(send1.outerEventIds, isNotEmpty);

        await _pumpUntil(
          a: a,
          b: b,
          condition: () =>
              _findRumor(a.decrypted, content: 'hello over relay') != null,
        );

        // Alice can now reply.
        final send2 = await aliceMgr.sendTextWithInnerId(
          recipientPubkeyHex: bob.publicKeyHex,
          text: 'hi bob',
        );
        expect(send2.outerEventIds, isNotEmpty);

        await _pumpUntil(
          a: a,
          b: b,
          condition: () => _findRumor(b.decrypted, content: 'hi bob') != null,
        );

        // Drop and reconnect transport (simulates relay/network issues).
        await aliceNostr.disconnect();
        await bobNostr.disconnect();
        await aliceNostr.connect();
        await bobNostr.connect();

        final send3 = await bobMgr.sendTextWithInnerId(
          recipientPubkeyHex: alice.publicKeyHex,
          text: 'after reconnect',
        );
        expect(send3.outerEventIds, isNotEmpty);

        await _pumpUntil(
          a: a,
          b: b,
          condition: () =>
              _findRumor(a.decrypted, content: 'after reconnect') != null,
        );

        await resp.session.dispose();
        await accept.session.dispose();
        await bobInvite.dispose();
        await invite.dispose();
      } finally {
        await a.stop();
        await b.stop();
        await aliceMgr.dispose();
        await bobMgr.dispose();
        await aliceNostr.dispose();
        await bobNostr.dispose();
        await relay.stop();

        // Best-effort cleanup.
        try {
          await aliceDir.delete(recursive: true);
        } catch (_) {}
        try {
          await bobDir.delete(recursive: true);
        } catch (_) {}
      }
    },
  );

  testWidgets('link device: link invite roundtrip over relay', (tester) async {
    await tester.pumpWidget(const SizedBox.shrink());

    if (!Platform.isMacOS) {
      return;
    }

    final relay = await TestRelay.start();
    final url = 'ws://127.0.0.1:${relay.port}';

    final deviceNostr = NostrService(relayUrls: [url]);
    final ownerNostr = NostrService(relayUrls: [url]);

    final ownerRepo = AuthRepositoryImpl(_createInMemorySecureStorage());
    final deviceRepo = AuthRepositoryImpl(_createInMemorySecureStorage());

    StreamSubscription<NostrEvent>? deviceSub;
    String? subid;

    InviteHandle? deviceInvite;
    InviteHandle? ownerInvite;
    InviteAcceptResult? accept;
    InviteResponseResult? response;

    try {
      await deviceNostr.connect();
      await ownerNostr.connect();

      // Owner creates an identity (main device).
      final ownerIdentity = await ownerRepo.createIdentity();
      final ownerPrivkeyHex = await ownerRepo.getPrivateKey();
      expect(ownerPrivkeyHex, isNotNull);

      // New device creates a link invite.
      final deviceKeypair = await NdrFfi.generateKeypair();
      deviceInvite = await NdrFfi.createInvite(
        inviterPubkeyHex: deviceKeypair.publicKeyHex,
        deviceId: deviceKeypair.publicKeyHex,
        maxUses: 1,
      );
      await deviceInvite.setPurpose('link');
      final inviteUrl = await deviceInvite.toUrl('https://iris.to');

      final data = decodeInviteUrlData(inviteUrl);
      final eph =
          (data?['ephemeralKey'] ?? data?['inviterEphemeralPublicKey'])
              as String?;
      expect(eph, isNotNull, reason: 'Invite URL missing ephemeral key');

      // Device subscribes for the accept response.
      subid = 'link-invite-${DateTime.now().microsecondsSinceEpoch}';
      final completer = Completer<NostrEvent>();
      deviceSub = deviceNostr.events.listen((event) {
        if (completer.isCompleted) return;
        if (event.subscriptionId != subid) return;
        if (event.kind != 1059) return;
        completer.complete(event);
      });

      deviceNostr.subscribeWithId(
        subid,
        NostrFilter(kinds: const [1059], pTags: [eph!]),
      );

      // Owner accepts (simulating Settings -> Link a Device -> scan).
      ownerInvite = await NdrFfi.inviteFromUrl(inviteUrl);
      accept = await ownerInvite.acceptWithOwner(
        inviteePubkeyHex: ownerIdentity.pubkeyHex,
        inviteePrivkeyHex: ownerPrivkeyHex!,
        deviceId: ownerIdentity.pubkeyHex,
        ownerPubkeyHex: ownerIdentity.pubkeyHex,
      );
      await ownerNostr.publishEvent(accept.responseEventJson);

      final event = await completer.future.timeout(const Duration(seconds: 8));

      // Device processes response and logs in as a linked device.
      response = await deviceInvite.processResponse(
        eventJson: jsonEncode(event.toJson()),
        inviterPrivkeyHex: deviceKeypair.privateKeyHex,
      );
      expect(response, isNotNull);

      final ownerPubkeyHex =
          response!.ownerPubkeyHex ?? response.inviteePubkeyHex;
      expect(ownerPubkeyHex, ownerIdentity.pubkeyHex);

      final identity = await deviceRepo.loginLinkedDevice(
        ownerPubkeyHex: ownerPubkeyHex,
        devicePrivkeyHex: deviceKeypair.privateKeyHex,
      );
      expect(identity.pubkeyHex, ownerIdentity.pubkeyHex);

      final currentIdentity = await deviceRepo.getCurrentIdentity();
      expect(currentIdentity?.pubkeyHex, ownerIdentity.pubkeyHex);

      final devicePubkeyHex = await deviceRepo.getDevicePubkeyHex();
      expect(devicePubkeyHex, deviceKeypair.publicKeyHex);
    } finally {
      if (subid != null) {
        deviceNostr.closeSubscription(subid);
      }
      await deviceSub?.cancel();

      // Best-effort cleanup; these are native handles.
      try {
        await response?.session.dispose();
      } catch (_) {}
      try {
        await accept?.session.dispose();
      } catch (_) {}
      try {
        await ownerInvite?.dispose();
      } catch (_) {}
      try {
        await deviceInvite?.dispose();
      } catch (_) {}

      await deviceNostr.dispose();
      await ownerNostr.dispose();
      await relay.stop();
    }
  });
}

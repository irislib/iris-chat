import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:iris_chat/core/ffi/ndr_ffi.dart';

class _PumpLog {
  final List<PubSubEvent> a = <PubSubEvent>[];
  final List<PubSubEvent> b = <PubSubEvent>[];
}

bool _isPublish(PubSubEvent e) =>
    (e.kind == 'publish' || e.kind == 'publish_signed') && e.eventJson != null;

Map<String, dynamic> _jsonMap(String s) => jsonDecode(s) as Map<String, dynamic>;

String _describeDecryptedEvents(List<PubSubEvent> events) {
  final lines = <String>[];
  for (final e in events) {
    if (e.kind != 'decrypted_message') continue;
    final sender = e.senderPubkeyHex ?? 'null';
    final eventId = e.eventId ?? 'null';

    var innerKind = 'unknown';
    var innerContent = '';
    final c = e.content;
    if (c == null) {
      innerKind = 'null-content';
    } else {
      try {
        final decoded = jsonDecode(c);
        if (decoded is Map<String, dynamic>) {
          final k = decoded['kind'];
          innerKind = k?.toString() ?? 'null';
          innerContent = (decoded['content'] ?? '').toString();
        } else {
          innerKind = 'non-map-json';
          innerContent = decoded.toString();
        }
      } catch (_) {
        innerKind = 'non-json';
        innerContent = c;
      }
    }

    final contentPreview =
        innerContent.length > 80 ? '${innerContent.substring(0, 80)}…' : innerContent;
    final senderPreview =
        sender.length >= 8 ? sender.substring(0, 8) : sender;
    final eventIdPreview =
        eventId.length >= 8 ? eventId.substring(0, 8) : eventId;

    lines.add(
      'sender=$senderPreview eventId=$eventIdPreview innerKind=$innerKind content="$contentPreview"',
    );
  }
  if (lines.isEmpty) return '(none)';
  return lines.join('\n');
}

String _describeKindCounts(List<PubSubEvent> events) {
  final counts = <String, int>{};
  for (final e in events) {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  }
  if (counts.isEmpty) return '(none)';
  return counts.entries.map((e) => '${e.key}:${e.value}').join(', ');
}

String _describePublishEvents(List<PubSubEvent> events) {
  final lines = <String>[];
  for (final e in events) {
    if (e.kind != 'publish' && e.kind != 'publish_signed') continue;
    final ej = e.eventJson;
    if (ej == null) {
      lines.add('${e.kind} eventJson=null');
      continue;
    }
    try {
      final m = _jsonMap(ej);
      final k = m['kind'];
      final id = m['id'];
      final pubkey = m['pubkey'];
      lines.add(
        '${e.kind} kind=$k id=${(id is String && id.length >= 8) ? id.substring(0, 8) : id} pubkey=${(pubkey is String && pubkey.length >= 8) ? pubkey.substring(0, 8) : pubkey}',
      );
    } catch (_) {
      lines.add('${e.kind} eventJson=non-json length=${ej.length}');
    }
  }
  if (lines.isEmpty) return '(none)';
  return lines.join('\n');
}

Future<_PumpLog> _pumpUntilSettled({
  required SessionManagerHandle a,
  required SessionManagerHandle b,
  int maxRounds = 50,
}) async {
  final log = _PumpLog();
  for (var i = 0; i < maxRounds; i++) {
    final aEvents = await a.drainEvents();
    final bEvents = await b.drainEvents();
    log.a.addAll(aEvents);
    log.b.addAll(bEvents);

    final aPublishes = aEvents.where(_isPublish).toList();
    final bPublishes = bEvents.where(_isPublish).toList();

    // Deliver outgoing publishes directly to the other manager, and also
    // echo back to the sender to mimic relay fan-out of our own publishes.
    for (final e in aPublishes) {
      await a.processEvent(e.eventJson!);
      await b.processEvent(e.eventJson!);
    }
    for (final e in bPublishes) {
      await a.processEvent(e.eventJson!);
      await b.processEvent(e.eventJson!);
    }

    if (aPublishes.isEmpty && bPublishes.isEmpty) {
      break;
    }
  }
  return log;
}

PubSubEvent? _findDecrypted(
  List<PubSubEvent> events, {
  required String senderPubkeyHex,
  required int kind,
}) {
  for (final e in events) {
    if (e.kind != 'decrypted_message') continue;
    if (e.senderPubkeyHex != senderPubkeyHex) continue;
    final content = e.content;
    if (content == null) continue;
    final m = _jsonMap(content);
    if (m['kind'] == kind) {
      return e;
    }
  }
  return null;
}

Future<Directory> _tempDir(String prefix) async {
  return Directory.systemTemp.createTemp(prefix);
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  group('ndr-ffi native (macOS)', () {
    testWidgets('smoke: version + keypair', (tester) async {
      await tester.pumpWidget(const SizedBox.shrink());

      final v = await NdrFfi.version();
      expect(v, isNotEmpty);
      expect(v, isNot('unknown'));

      final kp = await NdrFfi.generateKeypair();
      expect(kp.publicKeyHex, hasLength(64));
      expect(kp.privateKeyHex, hasLength(64));
    }, skip: !Platform.isMacOS);

    testWidgets('invite -> accept -> processResponse -> message decrypt', (tester) async {
      await tester.pumpWidget(const SizedBox.shrink());

      final alice = await NdrFfi.generateKeypair();
      final bob = await NdrFfi.generateKeypair();

      final invite = await NdrFfi.createInvite(
        inviterPubkeyHex: alice.publicKeyHex,
        deviceId: alice.publicKeyHex,
        maxUses: 1,
      );
      final url = await invite.toUrl('https://iris.to');

      final bobInvite = await NdrFfi.inviteFromUrl(url);
      final accept = await bobInvite.accept(
        inviteePubkeyHex: bob.publicKeyHex,
        inviteePrivkeyHex: bob.privateKeyHex,
        deviceId: bob.publicKeyHex,
      );

      final aliceResp = await invite.processResponse(
        eventJson: accept.responseEventJson,
        inviterPrivkeyHex: alice.privateKeyHex,
      );
      expect(aliceResp, isNotNull);

      // Bob sends a message; Alice decrypts it.
      final send = await accept.session.sendText('hello alice');
      final dec = await aliceResp!.session.decryptEvent(send.outerEventJson);

      final rumor = _jsonMap(dec.innerEventJson);
      // SessionHandle uses a plain text-note style inner event (kind 1).
      expect(rumor['kind'], 1);
      expect(rumor['content'], 'hello alice');

      await aliceResp.session.dispose();
      await accept.session.dispose();
      await bobInvite.dispose();
      await invite.dispose();
    }, skip: !Platform.isMacOS);

    testWidgets('session manager: inner ids + receipts + typing', (tester) async {
      await tester.pumpWidget(const SizedBox.shrink());

      final alice = await NdrFfi.generateKeypair();
      final bob = await NdrFfi.generateKeypair();

      final aliceDir = await _tempDir('ndr-macos-alice-');
      final bobDir = await _tempDir('ndr-macos-bob-');

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
      await aliceMgr.init();
      await bobMgr.init();

      // Process initial AppKeys publishes and subscriptions (no real relay in tests).
      await _pumpUntilSettled(a: aliceMgr, b: bobMgr);

      // Establish a session state via an invite, then import into both managers.
      final invite = await NdrFfi.createInvite(
        inviterPubkeyHex: alice.publicKeyHex,
        deviceId: alice.publicKeyHex,
        maxUses: 1,
      );
      final url = await invite.toUrl('https://iris.to');

      final bobInvite = await NdrFfi.inviteFromUrl(url);
      final accept = await bobInvite.accept(
        inviteePubkeyHex: bob.publicKeyHex,
        inviteePrivkeyHex: bob.privateKeyHex,
        deviceId: bob.publicKeyHex,
      );
      final aliceResp = await invite.processResponse(
        eventJson: accept.responseEventJson,
        inviterPrivkeyHex: alice.privateKeyHex,
      );
      expect(aliceResp, isNotNull);

      final aliceState = await aliceResp!.session.stateJson();
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

      // Send a text with a stable inner id.
      final send = await aliceMgr.sendTextWithInnerId(
        recipientPubkeyHex: bob.publicKeyHex,
        text: 'hi bob',
      );
      expect(send.innerId, isNotEmpty);

      // Deliver published events and wait for Bob to decrypt the rumor.
      final log1 = await _pumpUntilSettled(a: aliceMgr, b: bobMgr);
      final bobChat = _findDecrypted(
        log1.b,
        senderPubkeyHex: alice.publicKeyHex,
        kind: 14,
      );
      expect(
        bobChat,
        isNotNull,
        reason: 'Bob kind counts: ${_describeKindCounts(log1.b)}\n'
            'Alice kind counts: ${_describeKindCounts(log1.a)}\n'
            'Alice publish events:\n${_describePublishEvents(log1.a)}\n'
            'Bob publish events:\n${_describePublishEvents(log1.b)}\n'
            'Bob decrypted events:\n${_describeDecryptedEvents(log1.b)}',
      );
      final bobRumor = _jsonMap(bobChat!.content!);
      expect(bobRumor['content'], 'hi bob');

      // Stable inner id comes from the rumor id; PubSubEvent.eventId is the outer event id.
      final bobRumorId = bobRumor['id'] as String;
      expect(bobRumorId, send.innerId);

      // Bob sends delivered + seen receipts, and typing.
      await bobMgr.sendReceipt(
        recipientPubkeyHex: alice.publicKeyHex,
        receiptType: 'delivered',
        messageIds: [bobRumorId],
      );
      await bobMgr.sendReceipt(
        recipientPubkeyHex: alice.publicKeyHex,
        receiptType: 'seen',
        messageIds: [bobRumorId],
      );
      await bobMgr.sendTyping(recipientPubkeyHex: alice.publicKeyHex);

      final log2 = await _pumpUntilSettled(a: aliceMgr, b: bobMgr);

      final aliceDelivered = _findDecrypted(
        log2.a,
        senderPubkeyHex: bob.publicKeyHex,
        kind: 15,
      );
      expect(aliceDelivered, isNotNull);
      final deliveredRumor = _jsonMap(aliceDelivered!.content!);
      expect(deliveredRumor['content'], 'delivered');
      expect(
        (deliveredRumor['tags'] as List).any((t) {
          final tag = (t as List).map((e) => e.toString()).toList();
          return tag.length >= 2 && tag[0] == 'e' && tag[1] == bobRumorId;
        }),
        isTrue,
      );

      final aliceTyping = _findDecrypted(
        log2.a,
        senderPubkeyHex: bob.publicKeyHex,
        kind: 25,
      );
      expect(aliceTyping, isNotNull);

      await aliceResp.session.dispose();
      await accept.session.dispose();
      await bobInvite.dispose();
      await invite.dispose();
      await aliceMgr.dispose();
      await bobMgr.dispose();

      // Best-effort cleanup.
      try {
        await aliceDir.delete(recursive: true);
      } catch (_) {}
      try {
        await bobDir.delete(recursive: true);
      } catch (_) {}
    }, skip: !Platform.isMacOS);

    testWidgets('link invite: acceptWithOwner + appkeys create/parse', (tester) async {
      await tester.pumpWidget(const SizedBox.shrink());

      final owner = await NdrFfi.generateKeypair();
      final device = await NdrFfi.generateKeypair();

      final deviceInvite = await NdrFfi.createInvite(
        inviterPubkeyHex: device.publicKeyHex,
        deviceId: device.publicKeyHex,
        maxUses: 1,
      );
      await deviceInvite.setPurpose('link');
      final url = await deviceInvite.toUrl('https://iris.to');

      // Owner accepts the device's link invite.
      final ownerInvite = await NdrFfi.inviteFromUrl(url);
      final accept = await ownerInvite.acceptWithOwner(
        inviteePubkeyHex: owner.publicKeyHex,
        inviteePrivkeyHex: owner.privateKeyHex,
        deviceId: owner.publicKeyHex,
        ownerPubkeyHex: owner.publicKeyHex,
      );

      // Device processes the response and learns the owner pubkey.
      final resp = await deviceInvite.processResponse(
        eventJson: accept.responseEventJson,
        inviterPrivkeyHex: device.privateKeyHex,
      );
      expect(resp, isNotNull);
      expect(resp!.ownerPubkeyHex, owner.publicKeyHex);

      // AppKeys: include both devices.
      final appKeysEvent = await NdrFfi.createSignedAppKeysEvent(
        ownerPubkeyHex: owner.publicKeyHex,
        ownerPrivkeyHex: owner.privateKeyHex,
        devices: [
          FfiDeviceEntry(
            identityPubkeyHex: owner.publicKeyHex,
            createdAt: DateTime.now().millisecondsSinceEpoch ~/ 1000,
          ),
          FfiDeviceEntry(
            identityPubkeyHex: device.publicKeyHex,
            createdAt: DateTime.now().millisecondsSinceEpoch ~/ 1000,
          ),
        ],
      );
      final parsed = await NdrFfi.parseAppKeysEvent(appKeysEvent);
      final parsedKeys = parsed.map((d) => d.identityPubkeyHex).toSet();
      expect(parsedKeys, contains(owner.publicKeyHex));
      expect(parsedKeys, contains(device.publicKeyHex));

      await resp.session.dispose();
      await accept.session.dispose();
      await ownerInvite.dispose();
      await deviceInvite.dispose();
    }, skip: !Platform.isMacOS);
  });
}

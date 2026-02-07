import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

import '../../features/auth/domain/repositories/auth_repository.dart';
import '../../features/chat/data/datasources/session_local_datasource.dart';
import '../ffi/ndr_ffi.dart';
import 'logger_service.dart';
import 'nostr_service.dart';

class DecryptedMessage {
  const DecryptedMessage({
    required this.senderPubkeyHex,
    required this.content,
    this.eventId,
    this.createdAt,
  });

  final String senderPubkeyHex;
  final String content;
  final String? eventId;
  final int? createdAt;
}

/// Bridges NDR SessionManager with the app's Nostr transport.
class SessionManagerService {
  SessionManagerService(
    this._nostrService,
    this._sessionDatasource,
    this._authRepository, {
    String? storagePathOverride,
  }) : _storagePathOverride = storagePathOverride;

  final NostrService _nostrService;
  final SessionLocalDatasource _sessionDatasource;
  final AuthRepository _authRepository;
  final String? _storagePathOverride;

  final StreamController<DecryptedMessage> _decryptedController =
      StreamController<DecryptedMessage>.broadcast();

  Stream<DecryptedMessage> get decryptedMessages => _decryptedController.stream;

  SessionManagerHandle? _manager;
  String? _ownerPubkeyHex;
  StreamSubscription<NostrEvent>? _eventSubscription;
  Timer? _drainTimer;
  bool _draining = false;
  bool _started = false;
  final Map<String, int> _eventTimestamps = {};

  /// Owner public key (hex) for this session manager (differs for linked devices).
  String? get ownerPubkeyHex => _ownerPubkeyHex;

  Future<void> start() async {
    if (_started) return;
    _started = true;

    await _initManager();

    _eventSubscription = _nostrService.events.listen(_handleEvent);

    // Periodically drain events to avoid missing publishes/subscriptions.
    _drainTimer = Timer.periodic(const Duration(milliseconds: 200), (_) {
      _drainEvents();
    });
  }

  Future<void> dispose() async {
    await _eventSubscription?.cancel();
    _eventSubscription = null;
    _drainTimer?.cancel();
    _drainTimer = null;
    await _manager?.dispose();
    _manager = null;
    await _decryptedController.close();
  }

  Future<void> refreshSubscription() async {
    await _drainEvents();
  }

  Future<List<String>> sendText({
    required String recipientPubkeyHex,
    required String text,
  }) async {
    final manager = _manager;
    if (manager == null) {
      throw const NostrException('Session manager not initialized');
    }
    final eventIds = await manager.sendText(
      recipientPubkeyHex: recipientPubkeyHex,
      text: text,
    );
    await _drainEvents();
    return eventIds;
  }

  Future<SendTextWithInnerIdResult> sendTextWithInnerId({
    required String recipientPubkeyHex,
    required String text,
  }) async {
    final manager = _manager;
    if (manager == null) {
      throw const NostrException('Session manager not initialized');
    }
    final sendResult = await manager.sendTextWithInnerId(
      recipientPubkeyHex: recipientPubkeyHex,
      text: text,
    );
    await _drainEvents();
    return sendResult;
  }

  Future<SendTextWithInnerIdResult> sendEventWithInnerId({
    required String recipientPubkeyHex,
    required int kind,
    required String content,
    required String tagsJson,
    int? createdAtSeconds,
  }) async {
    final manager = _manager;
    if (manager == null) {
      throw const NostrException('Session manager not initialized');
    }
    final sendResult = await manager.sendEventWithInnerId(
      recipientPubkeyHex: recipientPubkeyHex,
      kind: kind,
      content: content,
      tagsJson: tagsJson,
      createdAtSeconds: createdAtSeconds,
    );
    await _drainEvents();
    return sendResult;
  }

  Future<void> sendReceipt({
    required String recipientPubkeyHex,
    required String receiptType,
    required List<String> messageIds,
  }) async {
    final manager = _manager;
    if (manager == null) return;
    await manager.sendReceipt(
      recipientPubkeyHex: recipientPubkeyHex,
      receiptType: receiptType,
      messageIds: messageIds,
    );
    await _drainEvents();
  }

  Future<void> sendTyping({required String recipientPubkeyHex}) async {
    final manager = _manager;
    if (manager == null) return;
    await manager.sendTyping(recipientPubkeyHex: recipientPubkeyHex);
    await _drainEvents();
  }

  Future<void> sendReaction({
    required String recipientPubkeyHex,
    required String messageId,
    required String emoji,
  }) async {
    final manager = _manager;
    if (manager == null) return;
    await manager.sendReaction(
      recipientPubkeyHex: recipientPubkeyHex,
      messageId: messageId,
      emoji: emoji,
    );
    await _drainEvents();
  }

  Future<void> importSessionState({
    required String peerPubkeyHex,
    required String stateJson,
    String? deviceId,
  }) async {
    final manager = _manager;
    if (manager == null) return;
    await manager.importSessionState(
      peerPubkeyHex: peerPubkeyHex,
      stateJson: stateJson,
      deviceId: deviceId,
    );
  }

  Future<String?> getActiveSessionState(String peerPubkeyHex) async {
    final manager = _manager;
    if (manager == null) return null;
    return manager.getActiveSessionState(peerPubkeyHex);
  }

  Future<int> getTotalSessions() async {
    final manager = _manager;
    if (manager == null) return 0;
    return manager.getTotalSessions();
  }

  Future<void> _initManager() async {
    final identity = await _authRepository.getCurrentIdentity();
    final devicePrivkeyHex = await _authRepository.getPrivateKey();
    if (identity?.pubkeyHex == null || devicePrivkeyHex == null) {
      Logger.warning(
        'Session manager not initialized: missing identity',
        category: LogCategory.session,
      );
      return;
    }

    final ownerPubkeyHex = identity!.pubkeyHex;
    final devicePubkeyHex = await NdrFfi.derivePublicKey(devicePrivkeyHex);

    final storagePath = await _resolveStoragePath();
    // ndr-ffi expects the directory to exist.
    await Directory(storagePath).create(recursive: true);

    _manager = await NdrFfi.createSessionManager(
      ourPubkeyHex: devicePubkeyHex,
      ourIdentityPrivkeyHex: devicePrivkeyHex,
      deviceId: devicePubkeyHex,
      storagePath: storagePath,
      ownerPubkeyHex: ownerPubkeyHex == devicePubkeyHex ? null : ownerPubkeyHex,
    );

    await _manager!.init();
    _ownerPubkeyHex = await _manager!.getOwnerPubkeyHex();

    // If storage is empty, import existing sessions from local DB.
    final total = await _manager!.getTotalSessions();
    if (total == 0) {
      await _importSessionsFromDb();
    }

    await _drainEvents();
  }

  Future<String> _resolveStoragePath() async {
    final override = _storagePathOverride;
    if (override != null && override.isNotEmpty) return override;

    final supportDir = await getApplicationSupportDirectory();
    return '${supportDir.path}/ndr';
  }

  Future<void> _importSessionsFromDb() async {
    final sessions = await _sessionDatasource.getAllSessions();
    for (final session in sessions) {
      final state = session.serializedState;
      if (state == null || state.isEmpty) continue;
      try {
        await _manager?.importSessionState(
          peerPubkeyHex: session.recipientPubkeyHex,
          stateJson: state,
        );
      } catch (_) {}
    }
  }

  Future<void> _handleEvent(NostrEvent event) async {
    // Only handle NDR-related kinds to reduce overhead.
    if (event.kind != 1060 &&
        event.kind != 1058 &&
        event.kind != 1059 &&
        event.kind != 30078) {
      return;
    }

    // De-dupe by id. It's normal to receive the same event multiple times
    // (multiple relays, overlapping subscriptions, reconnect replays).
    if (_eventTimestamps.containsKey(event.id)) return;
    _eventTimestamps[event.id] = event.createdAt;
    // Prevent unbounded growth in long-running sessions.
    if (_eventTimestamps.length > 10000) {
      // Map preserves insertion order; drop oldest.
      final keys = _eventTimestamps.keys.take(2000).toList();
      for (final k in keys) {
        _eventTimestamps.remove(k);
      }
    }

    final manager = _manager;
    if (manager == null) return;
    await manager.processEvent(jsonEncode(event.toJson()));
    await _drainEvents();
  }

  Future<void> _drainEvents() async {
    final manager = _manager;
    if (manager == null || _draining) return;
    _draining = true;
    try {
      while (true) {
        final events = await manager.drainEvents();
        if (events.isEmpty) break;
        for (final event in events) {
          await _handlePubSubEvent(event);
        }
      }
    } finally {
      _draining = false;
    }
  }

  Future<void> _handlePubSubEvent(PubSubEvent event) async {
    final manager = _manager;
    switch (event.kind) {
      case 'publish':
      case 'publish_signed':
        if (event.eventJson != null) {
          try {
            await _nostrService.publishEvent(event.eventJson!);
          } catch (_) {}
          // Loop back our own publishes so the native manager can advance state and
          // update subscriptions without relying on a relay echo + subscription.
          //
          // This is important for back-to-back sends (e.g., auto receipts + user reply).
          if (manager != null) {
            try {
              final decoded =
                  jsonDecode(event.eventJson!) as Map<String, dynamic>;
              final id = decoded['id'];
              final createdAt = decoded['created_at'];
              if (id is String && createdAt is num) {
                _eventTimestamps[id] = createdAt.toInt();
                if (_eventTimestamps.length > 10000) {
                  final keys = _eventTimestamps.keys.take(2000).toList();
                  for (final k in keys) {
                    _eventTimestamps.remove(k);
                  }
                }
              }
            } catch (_) {}
            try {
              await manager.processEvent(event.eventJson!);
            } catch (_) {}
          }
        }
        break;
      case 'subscribe':
        if (event.subid != null && event.filterJson != null) {
          final filterMap =
              jsonDecode(event.filterJson!) as Map<String, dynamic>;
          // Preserve unknown tag filters like `#d` and `#l`.
          _nostrService.subscribeWithIdRaw(event.subid!, filterMap);
        }
        break;
      case 'unsubscribe':
        if (event.subid != null) {
          _nostrService.closeSubscription(event.subid!);
        }
        break;
      case 'decrypted_message':
        if (event.senderPubkeyHex != null && event.content != null) {
          final createdAt = event.eventId != null
              ? _eventTimestamps[event.eventId!]
              : null;
          _decryptedController.add(
            DecryptedMessage(
              senderPubkeyHex: event.senderPubkeyHex!,
              content: event.content!,
              eventId: event.eventId,
              createdAt: createdAt,
            ),
          );
        }
        break;
      case 'received_event':
        // Optional: forward to app if needed.
        break;
    }
  }
}

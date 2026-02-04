import 'dart:async';
import 'dart:convert';

import 'package:path_provider/path_provider.dart';

import '../ffi/ndr_ffi.dart';
import 'logger_service.dart';
import 'nostr_service.dart';
import '../../features/auth/domain/repositories/auth_repository.dart';
import '../../features/chat/data/datasources/session_local_datasource.dart';

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
    this._authRepository,
  );

  final NostrService _nostrService;
  final SessionLocalDatasource _sessionDatasource;
  final AuthRepository _authRepository;

  final StreamController<DecryptedMessage> _decryptedController =
      StreamController<DecryptedMessage>.broadcast();

  Stream<DecryptedMessage> get decryptedMessages => _decryptedController.stream;

  SessionManagerHandle? _manager;
  StreamSubscription<NostrEvent>? _eventSubscription;
  Timer? _drainTimer;
  bool _draining = false;
  bool _started = false;
  final Map<String, int> _eventTimestamps = {};

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
    final privkeyHex = await _authRepository.getPrivateKey();
    if (identity?.pubkeyHex == null || privkeyHex == null) {
      Logger.warning(
        'Session manager not initialized: missing identity',
        category: LogCategory.session,
      );
      return;
    }

    final supportDir = await getApplicationSupportDirectory();
    final storagePath = '${supportDir.path}/ndr';

    _manager = await NdrFfi.createSessionManager(
      ourPubkeyHex: identity!.pubkeyHex!,
      ourIdentityPrivkeyHex: privkeyHex,
      deviceId: 'public',
      storagePath: storagePath,
    );

    await _manager!.init();

    // If storage is empty, import existing sessions from local DB.
    final total = await _manager!.getTotalSessions();
    if (total == 0) {
      await _importSessionsFromDb();
    }

    await _drainEvents();
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
    if (event.kind != 1060 && event.kind != 1059 && event.kind != 30078) {
      return;
    }

    _eventTimestamps[event.id] = event.createdAt;

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
      final events = await manager.drainEvents();
      for (final event in events) {
        await _handlePubSubEvent(event);
      }
    } finally {
      _draining = false;
    }
  }

  Future<void> _handlePubSubEvent(PubSubEvent event) async {
    switch (event.kind) {
      case 'publish':
      case 'publish_signed':
        if (event.eventJson != null) {
          try {
            await _nostrService.publishEvent(event.eventJson!);
          } catch (_) {}
        }
        break;
      case 'subscribe':
        if (event.subid != null && event.filterJson != null) {
          final filterMap =
              jsonDecode(event.filterJson!) as Map<String, dynamic>;
          final filter = NostrFilter.fromJson(filterMap);
          _nostrService.subscribeWithId(event.subid!, filter);
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

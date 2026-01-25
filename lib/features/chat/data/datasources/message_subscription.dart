import 'dart:async';

import '../../../../core/ffi/ndr_ffi.dart';
import '../../../../core/services/nostr_service.dart';
import 'session_local_datasource.dart';

/// Service that subscribes to incoming messages from Nostr relays
/// and routes them to the appropriate session handlers.
class MessageSubscription {
  MessageSubscription(this._nostrService, this._sessionDatasource);

  final NostrService _nostrService;
  final SessionLocalDatasource _sessionDatasource;

  String? _subscriptionId;
  StreamSubscription<NostrEvent>? _eventSubscription;

  /// Callback for when a message is received.
  void Function(String sessionId, String eventJson)? onMessage;

  /// Callback for when an invite response is received.
  void Function(String inviteId, String eventJson)? onInviteResponse;

  // Double ratchet message kind (from ndr-ffi)
  static const int drMessageKind = 443;
  static const int inviteResponseKind = 444;

  /// Start listening for messages.
  Future<void> startListening() async {
    // Get all sessions to extract ephemeral pubkeys
    final sessions = await _sessionDatasource.getAllSessions();

    // Collect all recipient pubkeys we should listen for
    final pubkeys = <String>[];
    for (final session in sessions) {
      // We listen for messages TO us, so we need to listen on our ephemeral keys
      // The session state contains these keys
      final stateJson = await _sessionDatasource.getSessionState(session.id);
      if (stateJson != null) {
        // Try to extract current ephemeral pubkey from state
        // This would need to be exposed via FFI
        pubkeys.add(session.recipientPubkeyHex);
      }
    }

    if (pubkeys.isEmpty) {
      return;
    }

    // Subscribe to double ratchet messages
    _subscriptionId = _nostrService.subscribe(
      NostrFilter(
        kinds: [drMessageKind, inviteResponseKind],
        pTags: pubkeys,
        since: DateTime.now().subtract(const Duration(days: 7)).millisecondsSinceEpoch ~/ 1000,
      ),
    );

    // Listen for events
    _eventSubscription = _nostrService.events.listen(_handleEvent);
  }

  void _handleEvent(NostrEvent event) {
    switch (event.kind) {
      case drMessageKind:
        _handleDrMessage(event);
        break;
      case inviteResponseKind:
        _handleInviteResponse(event);
        break;
    }
  }

  Future<void> _handleDrMessage(NostrEvent event) async {
    // Find the session this message belongs to
    final sessions = await _sessionDatasource.getAllSessions();

    for (final session in sessions) {
      // Try to decrypt with this session
      final stateJson = await _sessionDatasource.getSessionState(session.id);
      if (stateJson == null) continue;

      try {
        final handle = await NdrFfi.sessionFromStateJson(stateJson);
        final isDrMessage = await handle.isDrMessage(event.toJson().toString());

        if (isDrMessage) {
          // This message belongs to this session
          onMessage?.call(session.id, event.toJson().toString());
          await handle.dispose();
          return;
        }

        await handle.dispose();
      } catch (e) {
        // Not for this session, try next
      }
    }
  }

  void _handleInviteResponse(NostrEvent event) {
    // Route to invite handler
    // The 'e' tag should contain the invite event ID
    final inviteEventId = event.getTagValue('e');
    if (inviteEventId != null) {
      onInviteResponse?.call(inviteEventId, event.toJson().toString());
    }
  }

  /// Refresh the subscription with updated pubkeys.
  Future<void> refreshSubscription() async {
    await stopListening();
    await startListening();
  }

  /// Stop listening for messages.
  Future<void> stopListening() async {
    await _eventSubscription?.cancel();
    _eventSubscription = null;

    if (_subscriptionId != null) {
      _nostrService.closeSubscription(_subscriptionId!);
      _subscriptionId = null;
    }
  }
}

/// Extension to convert NostrEvent to JSON string.
extension NostrEventJson on NostrEvent {
  String toJsonString() {
    return '''{"id":"$id","pubkey":"$pubkey","created_at":$createdAt,"kind":$kind,"tags":${_tagsToJson()},"content":"$content","sig":"$sig"}''';
  }

  String _tagsToJson() {
    final tagStrings = tags.map((tag) {
      final escaped = tag.map((e) => '"$e"').join(',');
      return '[$escaped]';
    }).join(',');
    return '[$tagStrings]';
  }
}

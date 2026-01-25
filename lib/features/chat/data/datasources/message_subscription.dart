import 'dart:async';
import 'dart:convert';

import '../../../../core/ffi/ndr_ffi.dart';
import '../../../../core/services/logger_service.dart';
import '../../../../core/services/nostr_service.dart';
import '../../../invite/data/datasources/invite_local_datasource.dart';
import 'session_local_datasource.dart';

/// Service that subscribes to incoming messages from Nostr relays
/// and routes them to the appropriate session handlers.
class MessageSubscription {
  MessageSubscription(
    this._nostrService,
    this._sessionDatasource,
    this._inviteDatasource,
  );

  final NostrService _nostrService;
  final SessionLocalDatasource _sessionDatasource;
  final InviteLocalDatasource _inviteDatasource;

  String? _messageSubscriptionId;
  String? _inviteSubscriptionId;
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
    // Listen for events first
    _eventSubscription = _nostrService.events.listen(_handleEvent);

    // Start both subscription types
    await _startMessageSubscription();
    await _startInviteResponseSubscription();
  }

  /// Subscribe to DR messages from existing sessions.
  Future<void> _startMessageSubscription() async {
    final sessions = await _sessionDatasource.getAllSessions();

    // Collect ephemeral pubkeys from session states
    // We listen for messages FROM the other party, using their ephemeral keys
    final authors = <String>[];
    for (final session in sessions) {
      final stateJson = await _sessionDatasource.getSessionState(session.id);
      if (stateJson != null) {
        try {
          final state = jsonDecode(stateJson) as Map<String, dynamic>;

          // Get their current and next ephemeral pubkeys
          // Note: Rust FFI uses snake_case for SessionState serialization
          final theirCurrent = state['their_current_nostr_public_key'] as String?;
          final theirNext = state['their_next_nostr_public_key'] as String?;

          if (theirCurrent != null && theirCurrent.isNotEmpty) {
            authors.add(theirCurrent);
          }
          if (theirNext != null && theirNext.isNotEmpty) {
            authors.add(theirNext);
          }

          Logger.debug(
            'Session ephemeral keys',
            category: LogCategory.nostr,
            data: {
              'sessionId': session.id,
              'theirCurrent': theirCurrent?.substring(0, 8),
              'theirNext': theirNext?.substring(0, 8),
            },
          );
        } catch (e) {
          Logger.error(
            'Failed to parse session state',
            category: LogCategory.nostr,
            error: e,
            data: {'sessionId': session.id},
          );
        }
      }
    }

    final uniqueAuthors = authors.toSet().toList();

    Logger.info(
      'Starting message subscription',
      category: LogCategory.nostr,
      data: {
        'sessionCount': sessions.length,
        'authorCount': uniqueAuthors.length,
      },
    );

    if (uniqueAuthors.isEmpty) {
      Logger.debug(
        'No session ephemeral keys for message subscription',
        category: LogCategory.nostr,
      );
      return;
    }

    // Subscribe to DR messages using authors filter
    // Messages are sent FROM the other party's ephemeral keys
    _messageSubscriptionId = _nostrService.subscribe(
      NostrFilter(
        kinds: [drMessageKind],
        authors: uniqueAuthors,
        since: DateTime.now().subtract(const Duration(days: 7)).millisecondsSinceEpoch ~/ 1000,
        limit: 500,
      ),
    );
  }

  /// Subscribe to invite responses for pending invites.
  Future<void> _startInviteResponseSubscription() async {
    final invites = await _inviteDatasource.getActiveInvites();

    // Collect invite ephemeral pubkeys
    // Invite responses are sent TO the invite's ephemeral pubkey
    final invitePubkeys = <String>[];
    for (final invite in invites) {
      if (invite.serializedState != null) {
        try {
          final state = jsonDecode(invite.serializedState!) as Map<String, dynamic>;
          final ephemeralPubkey = state['inviterEphemeralPublicKey'] as String?;

          if (ephemeralPubkey != null && ephemeralPubkey.isNotEmpty) {
            invitePubkeys.add(ephemeralPubkey);

            Logger.debug(
              'Invite ephemeral key',
              category: LogCategory.nostr,
              data: {
                'inviteId': invite.id,
                'ephemeralPubkey': ephemeralPubkey.substring(0, 8),
              },
            );
          }
        } catch (e) {
          Logger.error(
            'Failed to parse invite state',
            category: LogCategory.nostr,
            error: e,
            data: {'inviteId': invite.id},
          );
        }
      }
    }

    final uniquePubkeys = invitePubkeys.toSet().toList();

    Logger.info(
      'Starting invite response subscription',
      category: LogCategory.nostr,
      data: {
        'inviteCount': invites.length,
        'pubkeyCount': uniquePubkeys.length,
      },
    );

    if (uniquePubkeys.isEmpty) {
      Logger.debug(
        'No invite ephemeral keys for response subscription',
        category: LogCategory.nostr,
      );
      return;
    }

    // Subscribe to invite responses using pTags filter
    // Responses are sent TO the invite's ephemeral pubkey
    _inviteSubscriptionId = _nostrService.subscribe(
      NostrFilter(
        kinds: [inviteResponseKind],
        pTags: uniquePubkeys,
        since: DateTime.now().subtract(const Duration(days: 7)).millisecondsSinceEpoch ~/ 1000,
      ),
    );
  }

  Future<void> _handleEvent(NostrEvent event) async {
    switch (event.kind) {
      case drMessageKind:
        await _handleDrMessage(event);
        break;
      case inviteResponseKind:
        await _handleInviteResponse(event);
        break;
    }
  }

  Future<void> _handleDrMessage(NostrEvent event) async {
    Logger.debug(
      'Handling DR message',
      category: LogCategory.message,
      data: {'eventId': event.id.substring(0, 8), 'pubkey': event.pubkey.substring(0, 8)},
    );

    // Convert event to proper JSON string
    final eventJson = jsonEncode(event.toJson());

    // Find the session this message belongs to
    final sessions = await _sessionDatasource.getAllSessions();
    Logger.debug(
      'Checking ${sessions.length} sessions',
      category: LogCategory.message,
    );

    for (final session in sessions) {
      // Try to decrypt with this session
      final stateJson = await _sessionDatasource.getSessionState(session.id);
      if (stateJson == null) continue;

      try {
        Logger.debug(
          'Restoring session for check',
          category: LogCategory.message,
          data: {'sessionId': session.id},
        );
        final handle = await NdrFfi.sessionFromStateJson(stateJson);

        Logger.debug(
          'Calling isDrMessage',
          category: LogCategory.message,
          data: {'sessionId': session.id},
        );
        final isDrMessage = await handle.isDrMessage(eventJson);

        Logger.debug(
          'isDrMessage result',
          category: LogCategory.message,
          data: {'sessionId': session.id, 'isDrMessage': isDrMessage},
        );

        if (isDrMessage) {
          // This message belongs to this session
          Logger.info(
            'Routing message to session',
            category: LogCategory.message,
            data: {'sessionId': session.id, 'eventId': event.id.substring(0, 8)},
          );
          onMessage?.call(session.id, eventJson);
          await handle.dispose();
          return;
        }

        await handle.dispose();
      } catch (e, st) {
        Logger.error(
          'Session check failed',
          category: LogCategory.message,
          error: e,
          stackTrace: st,
          data: {'sessionId': session.id},
        );
        // Not for this session, try next
      }
    }

    Logger.warning(
      'No session found for DR message',
      category: LogCategory.message,
      data: {'eventId': event.id.substring(0, 8)},
    );
  }

  Future<void> _handleInviteResponse(NostrEvent event) async {
    // Route to invite handler
    // The 'p' tag contains the invite ephemeral pubkey
    final inviteEphemeralPubkey = event.getTagValue('p');
    if (inviteEphemeralPubkey == null) {
      Logger.warning(
        'Invite response missing p tag',
        category: LogCategory.nostr,
        data: {'eventId': event.id},
      );
      return;
    }

    // Find the invite by ephemeral pubkey
    final invites = await _inviteDatasource.getActiveInvites();
    for (final invite in invites) {
      if (invite.serializedState != null) {
        try {
          final state = jsonDecode(invite.serializedState!) as Map<String, dynamic>;
          final ephemeralPubkey = state['inviterEphemeralPublicKey'] as String?;

          if (ephemeralPubkey == inviteEphemeralPubkey) {
            Logger.info(
              'Routing invite response',
              category: LogCategory.nostr,
              data: {
                'inviteId': invite.id,
                'ephemeralPubkey': ephemeralPubkey?.substring(0, 8),
              },
            );
            onInviteResponse?.call(invite.id, jsonEncode(event.toJson()));
            return;
          }
        } catch (e) {
          // Skip this invite if state parsing fails
        }
      }
    }

    Logger.warning(
      'No matching invite found for response',
      category: LogCategory.nostr,
      data: {
        'ephemeralPubkey': inviteEphemeralPubkey.substring(0, 8),
      },
    );
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

    if (_messageSubscriptionId != null) {
      _nostrService.closeSubscription(_messageSubscriptionId!);
      _messageSubscriptionId = null;
    }

    if (_inviteSubscriptionId != null) {
      _nostrService.closeSubscription(_inviteSubscriptionId!);
      _inviteSubscriptionId = null;
    }
  }
}

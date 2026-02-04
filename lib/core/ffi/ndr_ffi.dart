/// Dart bindings for ndr-ffi (Nostr Double Ratchet FFI)
///
/// This provides a Dart-friendly interface to the Rust ndr-ffi library
/// via platform channels to native code (Kotlin/Swift UniFFI bindings).
library;

import 'dart:async';

import 'package:flutter/services.dart';

import '../services/logger_service.dart';
import 'models/models.dart';

export 'models/models.dart';

/// Main interface to the ndr-ffi library.
///
/// All methods are static and communicate with native code via platform channels.
class NdrFfi {
  static const _channel = MethodChannel('to.iris.chat/ndr_ffi');

  /// Returns the version of the ndr-ffi library.
  static Future<String> version() async {
    Logger.ffiCall('version');
    final result = await _channel.invokeMethod<String>('version');
    Logger.ffiResult('version', success: result != null);
    return result ?? 'unknown';
  }

  /// Generate a new Nostr keypair.
  ///
  /// Returns a [FfiKeyPair] with hex-encoded public and private keys.
  static Future<FfiKeyPair> generateKeypair() async {
    Logger.cryptoStart('generateKeypair');
    try {
      final result = await _channel.invokeMethod<Map>('generateKeypair');
      if (result == null) {
        throw NdrException.invalidKey('Failed to generate keypair');
      }
      final keypair = FfiKeyPair.fromMap(Map<String, dynamic>.from(result));
      Logger.cryptoSuccess('generateKeypair', data: {
        'pubkey': keypair.publicKeyHex.substring(0, 8),
      });
      return keypair;
    } catch (e, st) {
      Logger.cryptoError('generateKeypair', e, stackTrace: st);
      rethrow;
    }
  }

  /// Create a new invite.
  ///
  /// [inviterPubkeyHex] - The inviter's public key as 64-char hex string.
  /// [deviceId] - Optional device identifier for multi-device support.
  /// [maxUses] - Optional maximum number of times this invite can be accepted.
  static Future<InviteHandle> createInvite({
    required String inviterPubkeyHex,
    String? deviceId,
    int? maxUses,
  }) async {
    Logger.debug(
      'Creating invite',
      category: LogCategory.invite,
      data: {'pubkey': inviterPubkeyHex.substring(0, 8), 'maxUses': maxUses},
    );
    try {
      final result = await _channel.invokeMethod<Map>('createInvite', {
        'inviterPubkeyHex': inviterPubkeyHex,
        'deviceId': deviceId,
        'maxUses': maxUses,
      });
      if (result == null) {
        throw NdrException.inviteError('Failed to create invite');
      }
      final invite = InviteHandle._fromMap(Map<String, dynamic>.from(result));
      Logger.info(
        'Invite created',
        category: LogCategory.invite,
        data: {'inviteId': invite._id},
      );
      return invite;
    } catch (e, st) {
      Logger.error(
        'Failed to create invite',
        category: LogCategory.invite,
        error: e,
        stackTrace: st,
      );
      rethrow;
    }
  }

  /// Parse an invite from a URL.
  static Future<InviteHandle> inviteFromUrl(String url) async {
    Logger.debug(
      'Parsing invite from URL',
      category: LogCategory.invite,
    );
    try {
      final result = await _channel.invokeMethod<Map>('inviteFromUrl', {
        'url': url,
      });
      if (result == null) {
        throw NdrException.inviteError('Failed to parse invite URL');
      }
      final invite = InviteHandle._fromMap(Map<String, dynamic>.from(result));
      Logger.info(
        'Invite parsed from URL',
        category: LogCategory.invite,
        data: {'inviteId': invite._id},
      );
      return invite;
    } catch (e, st) {
      Logger.error(
        'Failed to parse invite URL',
        category: LogCategory.invite,
        error: e,
        stackTrace: st,
      );
      rethrow;
    }
  }

  /// Parse an invite from a Nostr event JSON.
  static Future<InviteHandle> inviteFromEventJson(String eventJson) async {
    final result = await _channel.invokeMethod<Map>('inviteFromEventJson', {
      'eventJson': eventJson,
    });
    if (result == null) {
      throw NdrException.inviteError('Failed to parse invite event');
    }
    return InviteHandle._fromMap(Map<String, dynamic>.from(result));
  }

  /// Deserialize an invite from JSON (for persistence).
  static Future<InviteHandle> inviteDeserialize(String json) async {
    final result = await _channel.invokeMethod<Map>('inviteDeserialize', {
      'json': json,
    });
    if (result == null) {
      throw NdrException.serialization('Failed to deserialize invite');
    }
    return InviteHandle._fromMap(Map<String, dynamic>.from(result));
  }

  /// Restore a session from serialized state JSON.
  static Future<SessionHandle> sessionFromStateJson(String stateJson) async {
    Logger.sessionEvent('Restoring session from state');
    try {
      final result = await _channel.invokeMethod<Map>('sessionFromStateJson', {
        'stateJson': stateJson,
      });
      if (result == null) {
        throw NdrException.serialization('Failed to restore session');
      }
      final session = SessionHandle._fromMap(Map<String, dynamic>.from(result));
      Logger.sessionEvent('Session restored', sessionId: session._id);
      return session;
    } catch (e, st) {
      Logger.error(
        'Failed to restore session',
        category: LogCategory.session,
        error: e,
        stackTrace: st,
      );
      rethrow;
    }
  }

  /// Derive a public key from a private key.
  ///
  /// [privkeyHex] - The private key as 64-char hex string.
  /// Returns the public key as 64-char hex string.
  static Future<String> derivePublicKey(String privkeyHex) async {
    Logger.cryptoStart('derivePublicKey');
    try {
      final result = await _channel.invokeMethod<String>('derivePublicKey', {
        'privkeyHex': privkeyHex,
      });
      if (result == null) {
        throw NdrException.invalidKey('Failed to derive public key');
      }
      Logger.cryptoSuccess('derivePublicKey', data: {
        'pubkey': result.substring(0, 8),
      });
      return result;
    } catch (e, st) {
      Logger.cryptoError('derivePublicKey', e, stackTrace: st);
      rethrow;
    }
  }

  /// Initialize a new session directly (advanced use).
  static Future<SessionHandle> sessionInit({
    required String theirEphemeralPubkeyHex,
    required String ourEphemeralPrivkeyHex,
    required bool isInitiator,
    required String sharedSecretHex,
    String? name,
  }) async {
    Logger.sessionEvent(
      'Initializing session directly',
      data: {'isInitiator': isInitiator, 'name': name},
    );
    try {
      final result = await _channel.invokeMethod<Map>('sessionInit', {
        'theirEphemeralPubkeyHex': theirEphemeralPubkeyHex,
        'ourEphemeralPrivkeyHex': ourEphemeralPrivkeyHex,
        'isInitiator': isInitiator,
        'sharedSecretHex': sharedSecretHex,
        'name': name,
      });
      if (result == null) {
        throw NdrException.sessionNotReady('Failed to initialize session');
      }
      final session = SessionHandle._fromMap(Map<String, dynamic>.from(result));
      Logger.sessionEvent('Session initialized', sessionId: session._id);
      return session;
    } catch (e, st) {
      Logger.error(
        'Failed to initialize session',
        category: LogCategory.session,
        error: e,
        stackTrace: st,
      );
      rethrow;
    }
  }

  /// Create a new SessionManager handle.
  static Future<SessionManagerHandle> createSessionManager({
    required String ourPubkeyHex,
    required String ourIdentityPrivkeyHex,
    required String deviceId,
    String? storagePath,
  }) async {
    final method =
        storagePath == null ? 'sessionManagerNew' : 'sessionManagerNewWithStoragePath';
    final result = await _channel.invokeMethod<Map>(method, {
      'ourPubkeyHex': ourPubkeyHex,
      'ourIdentityPrivkeyHex': ourIdentityPrivkeyHex,
      'deviceId': deviceId,
      if (storagePath != null) 'storagePath': storagePath,
    });
    if (result == null) {
      throw NdrException.sessionNotReady('Failed to create session manager');
    }
    return SessionManagerHandle._fromMap(Map<String, dynamic>.from(result));
  }
}

/// Handle to an invite in native code.
///
/// This class wraps native operations on an invite object.
class InviteHandle {
  InviteHandle._(this._id);

  factory InviteHandle._fromMap(Map<String, dynamic> map) {
    return InviteHandle._(map['id'] as String);
  }

  final String _id;

  static const _channel = MethodChannel('to.iris.chat/ndr_ffi');

  /// Unique identifier for this invite handle.
  String get id => _id;

  /// Convert the invite to a shareable URL.
  Future<String> toUrl(String root) async {
    final result = await _channel.invokeMethod<String>('inviteToUrl', {
      'id': _id,
      'root': root,
    });
    if (result == null) {
      throw NdrException.inviteError('Failed to generate URL');
    }
    return result;
  }

  /// Convert the invite to a Nostr event JSON.
  Future<String> toEventJson() async {
    final result = await _channel.invokeMethod<String>('inviteToEventJson', {
      'id': _id,
    });
    if (result == null) {
      throw NdrException.inviteError('Failed to generate event');
    }
    return result;
  }

  /// Serialize the invite to JSON for persistence.
  Future<String> serialize() async {
    final result = await _channel.invokeMethod<String>('inviteSerialize', {
      'id': _id,
    });
    if (result == null) {
      throw NdrException.serialization('Failed to serialize invite');
    }
    return result;
  }

  /// Accept the invite and create a session.
  ///
  /// Returns an [InviteAcceptResult] containing the session and response event.
  Future<InviteAcceptResult> accept({
    required String inviteePubkeyHex,
    required String inviteePrivkeyHex,
    String? deviceId,
  }) async {
    Logger.info(
      'Accepting invite',
      category: LogCategory.invite,
      data: {
        'inviteId': _id,
        'inviteePubkey': inviteePubkeyHex.substring(0, 8),
      },
    );
    try {
      final result = await _channel.invokeMethod<Map>('inviteAccept', {
        'id': _id,
        'inviteePubkeyHex': inviteePubkeyHex,
        'inviteePrivkeyHex': inviteePrivkeyHex,
        'deviceId': deviceId,
      });
      if (result == null) {
        throw NdrException.inviteError('Failed to accept invite');
      }
      final acceptResult =
          InviteAcceptResult._fromMap(Map<String, dynamic>.from(result));
      Logger.sessionEvent(
        'Session established from invite',
        sessionId: acceptResult.session._id,
        data: {'inviteId': _id},
      );
      return acceptResult;
    } catch (e, st) {
      Logger.error(
        'Failed to accept invite',
        category: LogCategory.invite,
        error: e,
        stackTrace: st,
        data: {'inviteId': _id},
      );
      rethrow;
    }
  }

  /// Get the inviter's public key as hex.
  Future<String> getInviterPubkeyHex() async {
    final result =
        await _channel.invokeMethod<String>('inviteGetInviterPubkeyHex', {
      'id': _id,
    });
    if (result == null) {
      throw NdrException.inviteError('Failed to get inviter pubkey');
    }
    return result;
  }

  /// Get the shared secret as hex.
  Future<String> getSharedSecretHex() async {
    final result =
        await _channel.invokeMethod<String>('inviteGetSharedSecretHex', {
      'id': _id,
    });
    if (result == null) {
      throw NdrException.inviteError('Failed to get shared secret');
    }
    return result;
  }

  /// Process an invite response event and create a session.
  ///
  /// This is called when someone accepts your invite and sends a response.
  /// Returns an [InviteResponseResult] containing the session and invitee info,
  /// or null if the response is not valid for this invite.
  Future<InviteResponseResult?> processResponse({
    required String eventJson,
    required String inviterPrivkeyHex,
  }) async {
    Logger.info(
      'Processing invite response',
      category: LogCategory.invite,
      data: {'inviteId': _id},
    );
    try {
      final result = await _channel.invokeMethod<Map>('inviteProcessResponse', {
        'id': _id,
        'eventJson': eventJson,
        'inviterPrivkeyHex': inviterPrivkeyHex,
      });
      if (result == null) {
        return null;
      }
      final responseResult =
          InviteResponseResult._fromMap(Map<String, dynamic>.from(result));
      Logger.sessionEvent(
        'Session established from invite response',
        sessionId: responseResult.session._id,
        data: {
          'inviteId': _id,
          'invitee': responseResult.inviteePubkeyHex.substring(0, 8),
        },
      );
      return responseResult;
    } catch (e, st) {
      Logger.error(
        'Failed to process invite response',
        category: LogCategory.invite,
        error: e,
        stackTrace: st,
        data: {'inviteId': _id},
      );
      rethrow;
    }
  }

  /// Dispose of the native invite handle.
  Future<void> dispose() async {
    Logger.debug(
      'Disposing invite handle',
      category: LogCategory.invite,
      data: {'inviteId': _id},
    );
    await _channel.invokeMethod<void>('inviteDispose', {'id': _id});
  }
}

/// Handle to a session in native code.
///
/// This class wraps native operations on a session object.
class SessionHandle {
  SessionHandle._(this._id);

  factory SessionHandle._fromMap(Map<String, dynamic> map) {
    return SessionHandle._(map['id'] as String);
  }

  final String _id;

  static const _channel = MethodChannel('to.iris.chat/ndr_ffi');

  /// Unique identifier for this session handle.
  String get id => _id;

  /// Check if the session is ready to send messages.
  Future<bool> canSend() async {
    final result = await _channel.invokeMethod<bool>('sessionCanSend', {
      'id': _id,
    });
    return result ?? false;
  }

  /// Send a text message.
  ///
  /// Returns a [SendResult] containing the encrypted outer event
  /// and the original inner event.
  Future<SendResult> sendText(String text) async {
    Logger.cryptoStart('sendText', data: {
      'sessionId': _id,
      'textLength': text.length,
    });
    try {
      final result = await _channel.invokeMethod<Map>('sessionSendText', {
        'id': _id,
        'text': text,
      });
      if (result == null) {
        throw NdrException.sessionNotReady('Failed to send message');
      }
      final sendResult = SendResult.fromMap(Map<String, dynamic>.from(result));
      Logger.cryptoSuccess('sendText', data: {'sessionId': _id});
      Logger.messageEvent(
        'Message encrypted and ready to send',
        sessionId: _id,
        data: {'textLength': text.length},
      );
      return sendResult;
    } catch (e, st) {
      Logger.cryptoError('sendText', e, stackTrace: st, data: {'sessionId': _id});
      rethrow;
    }
  }

  /// Decrypt a received event.
  ///
  /// Returns a [DecryptResult] containing the plaintext and inner event.
  Future<DecryptResult> decryptEvent(String outerEventJson) async {
    Logger.cryptoStart('decryptEvent', data: {'sessionId': _id});
    try {
      final result = await _channel.invokeMethod<Map>('sessionDecryptEvent', {
        'id': _id,
        'outerEventJson': outerEventJson,
      });
      if (result == null) {
        throw NdrException.cryptoFailure('Failed to decrypt event');
      }
      final decryptResult =
          DecryptResult.fromMap(Map<String, dynamic>.from(result));
      Logger.cryptoSuccess('decryptEvent', data: {'sessionId': _id});
      Logger.messageEvent(
        'Message decrypted',
        sessionId: _id,
        data: {'plaintextLength': decryptResult.plaintext.length},
      );
      return decryptResult;
    } catch (e, st) {
      Logger.cryptoError('decryptEvent', e, stackTrace: st, data: {'sessionId': _id});
      rethrow;
    }
  }

  /// Serialize the session state to JSON.
  Future<String> stateJson() async {
    Logger.debug(
      'Serializing session state',
      category: LogCategory.session,
      data: {'sessionId': _id},
    );
    final result = await _channel.invokeMethod<String>('sessionStateJson', {
      'id': _id,
    });
    if (result == null) {
      throw NdrException.serialization('Failed to serialize session');
    }
    Logger.debug(
      'Session state serialized',
      category: LogCategory.session,
      data: {'sessionId': _id, 'stateLength': result.length},
    );
    return result;
  }

  /// Check if an event is a double-ratchet message.
  Future<bool> isDrMessage(String eventJson) async {
    final result = await _channel.invokeMethod<bool>('sessionIsDrMessage', {
      'id': _id,
      'eventJson': eventJson,
    });
    return result ?? false;
  }

  /// Dispose of the native session handle.
  Future<void> dispose() async {
    Logger.sessionEvent('Disposing session', sessionId: _id);
    await _channel.invokeMethod<void>('sessionDispose', {'id': _id});
  }
}

/// Handle to a session manager in native code.
class SessionManagerHandle {
  SessionManagerHandle._(this._id);

  factory SessionManagerHandle._fromMap(Map<String, dynamic> map) {
    return SessionManagerHandle._(map['id'] as String);
  }

  final String _id;

  static const _channel = MethodChannel('to.iris.chat/ndr_ffi');

  /// Unique identifier for this session manager handle.
  String get id => _id;

  /// Initialize the session manager (loads state, creates invite, subscribes).
  Future<void> init() async {
    await _channel.invokeMethod<void>('sessionManagerInit', {
      'id': _id,
    });
  }

  /// Send a text message to a recipient.
  Future<List<String>> sendText({
    required String recipientPubkeyHex,
    required String text,
  }) async {
    final result = await _channel.invokeMethod<List>('sessionManagerSendText', {
      'id': _id,
      'recipientPubkeyHex': recipientPubkeyHex,
      'text': text,
    });
    if (result == null) {
      return [];
    }
    return result.map((e) => e.toString()).toList();
  }

  /// Import a session state for a peer.
  Future<void> importSessionState({
    required String peerPubkeyHex,
    required String stateJson,
    String? deviceId,
  }) async {
    await _channel.invokeMethod<void>('sessionManagerImportSessionState', {
      'id': _id,
      'peerPubkeyHex': peerPubkeyHex,
      'stateJson': stateJson,
      'deviceId': deviceId,
    });
  }

  /// Export the active session state for a peer.
  Future<String?> getActiveSessionState(String peerPubkeyHex) async {
    final result =
        await _channel.invokeMethod<String>('sessionManagerGetActiveSessionState', {
      'id': _id,
      'peerPubkeyHex': peerPubkeyHex,
    });
    return result;
  }

  /// Process a received Nostr event JSON.
  Future<void> processEvent(String eventJson) async {
    await _channel.invokeMethod<void>('sessionManagerProcessEvent', {
      'id': _id,
      'eventJson': eventJson,
    });
  }

  /// Drain pending pubsub events from the native queue.
  Future<List<PubSubEvent>> drainEvents() async {
    final result = await _channel.invokeMethod<List>('sessionManagerDrainEvents', {
      'id': _id,
    });
    if (result == null) return [];
    return result
        .map((e) => PubSubEvent.fromMap(Map<String, dynamic>.from(e as Map)))
        .toList();
  }

  /// Get the device id used by this session manager.
  Future<String> getDeviceId() async {
    final result = await _channel.invokeMethod<String>('sessionManagerGetDeviceId', {
      'id': _id,
    });
    return result ?? '';
  }

  /// Get our public key as hex.
  Future<String> getOurPubkeyHex() async {
    final result = await _channel.invokeMethod<String>('sessionManagerGetOurPubkeyHex', {
      'id': _id,
    });
    return result ?? '';
  }

  /// Get total active sessions.
  Future<int> getTotalSessions() async {
    final result = await _channel.invokeMethod<int>('sessionManagerGetTotalSessions', {
      'id': _id,
    });
    return result ?? 0;
  }

  /// Dispose of the native session manager handle.
  Future<void> dispose() async {
    await _channel.invokeMethod<void>('sessionManagerDispose', {'id': _id});
  }
}

/// Result of accepting an invite.
class InviteAcceptResult {
  InviteAcceptResult({
    required this.session,
    required this.responseEventJson,
  });

  factory InviteAcceptResult._fromMap(Map<String, dynamic> map) {
    return InviteAcceptResult(
      session: SessionHandle._fromMap(
        Map<String, dynamic>.from(map['session'] as Map),
      ),
      responseEventJson: map['responseEventJson'] as String,
    );
  }

  final SessionHandle session;
  final String responseEventJson;
}

/// Result of processing an invite response.
class InviteResponseResult {
  InviteResponseResult({
    required this.session,
    required this.inviteePubkeyHex,
    this.deviceId,
  });

  factory InviteResponseResult._fromMap(Map<String, dynamic> map) {
    return InviteResponseResult(
      session: SessionHandle._fromMap(
        Map<String, dynamic>.from(map['session'] as Map),
      ),
      inviteePubkeyHex: map['inviteePubkeyHex'] as String,
      deviceId: map['deviceId'] as String?,
    );
  }

  final SessionHandle session;
  final String inviteePubkeyHex;
  final String? deviceId;
}

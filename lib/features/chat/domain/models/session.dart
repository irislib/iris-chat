import 'package:freezed_annotation/freezed_annotation.dart';

import '../../../../shared/utils/animal_names.dart';

part 'session.freezed.dart';
part 'session.g.dart';

/// Represents an encrypted chat session with another user.
@freezed
class ChatSession with _$ChatSession {
  const factory ChatSession({
    /// Unique identifier for this session.
    required String id,

    /// The recipient's Nostr public key as hex.
    required String recipientPubkeyHex,

    /// Optional display name for the recipient.
    String? recipientName,

    /// When the session was created.
    required DateTime createdAt,

    /// When the last message was sent/received.
    DateTime? lastMessageAt,

    /// Preview of the last message.
    String? lastMessagePreview,

    /// Number of unread messages.
    @Default(0) int unreadCount,

    /// The invite ID that created this session (if any).
    String? inviteId,

    /// Whether we initiated this session.
    @Default(false) bool isInitiator,

    /// Serialized session state for persistence.
    String? serializedState,
  }) = _ChatSession;

  const ChatSession._();

  factory ChatSession.fromJson(Map<String, dynamic> json) =>
      _$ChatSessionFromJson(json);

  /// Get a display name for the recipient.
  /// Falls back to animal name based on pubkey if no custom name set.
  String get displayName => getDisplayName(recipientPubkeyHex, recipientName);
}

/// Session state for UI purposes.
enum SessionStatus {
  /// Session is active and can send/receive.
  active,

  /// Session is pending (waiting for response).
  pending,

  /// Session has an error.
  error,
}

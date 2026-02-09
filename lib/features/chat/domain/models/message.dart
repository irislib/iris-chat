import 'package:freezed_annotation/freezed_annotation.dart';

part 'message.freezed.dart';
part 'message.g.dart';

/// Represents a chat message.
@freezed
abstract class ChatMessage with _$ChatMessage {
  const factory ChatMessage({
    /// Unique identifier for this message.
    required String id,

    /// The session this message belongs to.
    required String sessionId,

    /// The message content.
    required String text,

    /// When the message was created.
    required DateTime timestamp,

    /// Unix timestamp in seconds when this message expires (NIP-40).
    ///
    /// `null` means it does not expire.
    int? expiresAt,

    /// Direction of the message.
    required MessageDirection direction,

    /// Current status of the message.
    @Default(MessageStatus.pending) MessageStatus status,

    /// The Nostr event ID (outer event).
    String? eventId,

    /// Stable inner event id (rumor id). Used for receipts and multi-device de-duplication.
    String? rumorId,

    /// Optional reply reference.
    String? replyToId,

    /// Reactions: emoji -> list of pubkeys who reacted.
    @Default({}) Map<String, List<String>> reactions,

    /// Sender identity pubkey (hex) for group messages.
    ///
    /// For 1:1 DMs this is redundant (the session already implies the peer),
    /// so it's typically null.
    String? senderPubkeyHex,
  }) = _ChatMessage;

  const ChatMessage._();

  factory ChatMessage.fromJson(Map<String, dynamic> json) =>
      _$ChatMessageFromJson(json);

  /// Create an outgoing message.
  factory ChatMessage.outgoing({
    required String sessionId,
    required String text,
    String? replyToId,
    int? expiresAt,
  }) {
    return ChatMessage(
      id: DateTime.now().microsecondsSinceEpoch.toString(),
      sessionId: sessionId,
      text: text,
      timestamp: DateTime.now(),
      expiresAt: expiresAt,
      direction: MessageDirection.outgoing,
      status: MessageStatus.pending,
      rumorId: null,
      replyToId: replyToId,
    );
  }

  /// Create an incoming message.
  factory ChatMessage.incoming({
    required String sessionId,
    required String text,
    required String eventId,
    required String rumorId,
    DateTime? timestamp,
    int? expiresAt,
    String? senderPubkeyHex,
  }) {
    return ChatMessage(
      id: rumorId,
      sessionId: sessionId,
      text: text,
      timestamp: timestamp ?? DateTime.now(),
      expiresAt: expiresAt,
      direction: MessageDirection.incoming,
      status: MessageStatus.delivered,
      eventId: eventId,
      rumorId: rumorId,
      senderPubkeyHex: senderPubkeyHex,
    );
  }

  /// Whether this is an outgoing message.
  bool get isOutgoing => direction == MessageDirection.outgoing;

  /// Whether this is an incoming message.
  bool get isIncoming => direction == MessageDirection.incoming;

  /// Whether the message has been sent.
  bool get isSent =>
      status == MessageStatus.sent ||
      status == MessageStatus.delivered ||
      status == MessageStatus.seen;
}

/// Direction of a message.
enum MessageDirection { incoming, outgoing }

/// Status of a message.
enum MessageStatus {
  /// Message is being sent.
  pending,

  /// Message is queued (offline).
  queued,

  /// Message has been sent to relays.
  sent,

  /// Message has been delivered (received by recipient).
  delivered,

  /// Message has been seen (read by recipient).
  seen,

  /// Message failed to send.
  failed,
}

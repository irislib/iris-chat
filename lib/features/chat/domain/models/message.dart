import 'package:freezed_annotation/freezed_annotation.dart';

part 'message.freezed.dart';
part 'message.g.dart';

/// Represents a chat message.
@freezed
class ChatMessage with _$ChatMessage {
  const factory ChatMessage({
    /// Unique identifier for this message.
    required String id,

    /// The session this message belongs to.
    required String sessionId,

    /// The message content.
    required String text,

    /// When the message was created.
    required DateTime timestamp,

    /// Direction of the message.
    required MessageDirection direction,

    /// Current status of the message.
    @Default(MessageStatus.pending) MessageStatus status,

    /// The Nostr event ID (outer event).
    String? eventId,

    /// Optional reply reference.
    String? replyToId,
  }) = _ChatMessage;

  const ChatMessage._();

  factory ChatMessage.fromJson(Map<String, dynamic> json) =>
      _$ChatMessageFromJson(json);

  /// Create an outgoing message.
  factory ChatMessage.outgoing({
    required String sessionId,
    required String text,
    String? replyToId,
  }) {
    return ChatMessage(
      id: DateTime.now().microsecondsSinceEpoch.toString(),
      sessionId: sessionId,
      text: text,
      timestamp: DateTime.now(),
      direction: MessageDirection.outgoing,
      status: MessageStatus.pending,
      replyToId: replyToId,
    );
  }

  /// Create an incoming message.
  factory ChatMessage.incoming({
    required String sessionId,
    required String text,
    required String eventId,
    DateTime? timestamp,
  }) {
    return ChatMessage(
      id: eventId,
      sessionId: sessionId,
      text: text,
      timestamp: timestamp ?? DateTime.now(),
      direction: MessageDirection.incoming,
      status: MessageStatus.delivered,
      eventId: eventId,
    );
  }

  /// Whether this is an outgoing message.
  bool get isOutgoing => direction == MessageDirection.outgoing;

  /// Whether this is an incoming message.
  bool get isIncoming => direction == MessageDirection.incoming;

  /// Whether the message has been sent.
  bool get isSent => status == MessageStatus.sent || status == MessageStatus.delivered;
}

/// Direction of a message.
enum MessageDirection {
  incoming,
  outgoing,
}

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

  /// Message failed to send.
  failed,
}

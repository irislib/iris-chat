/// Event emitted by the NDR SessionManager for external pub/sub handling.
class PubSubEvent {
  const PubSubEvent({
    required this.kind,
    this.subid,
    this.filterJson,
    this.eventJson,
    this.senderPubkeyHex,
    this.content,
    this.eventId,
  });

  factory PubSubEvent.fromMap(Map<String, dynamic> map) {
    return PubSubEvent(
      kind: map['kind'] as String,
      subid: map['subid'] as String?,
      filterJson: map['filterJson'] as String?,
      eventJson: map['eventJson'] as String?,
      senderPubkeyHex: map['senderPubkeyHex'] as String?,
      content: map['content'] as String?,
      eventId: map['eventId'] as String?,
    );
  }

  /// Type of event: publish, publish_signed, subscribe, unsubscribe, decrypted_message, received_event.
  final String kind;

  /// Subscription id for subscribe/unsubscribe.
  final String? subid;

  /// Nostr filter JSON for subscribe.
  final String? filterJson;

  /// Nostr event JSON for publish or received_event.
  final String? eventJson;

  /// Sender pubkey hex for decrypted messages.
  final String? senderPubkeyHex;

  /// Decrypted content for decrypted messages.
  final String? content;

  /// Event id for decrypted messages.
  final String? eventId;

  Map<String, dynamic> toMap() {
    return {
      'kind': kind,
      'subid': subid,
      'filterJson': filterJson,
      'eventJson': eventJson,
      'senderPubkeyHex': senderPubkeyHex,
      'content': content,
      'eventId': eventId,
    };
  }
}

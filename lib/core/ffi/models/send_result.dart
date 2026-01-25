/// Result of sending a message through the double ratchet.
class SendResult {
  const SendResult({
    required this.outerEventJson,
    required this.innerEventJson,
  });

  factory SendResult.fromMap(Map<String, dynamic> map) {
    return SendResult(
      outerEventJson: map['outerEventJson'] as String,
      innerEventJson: map['innerEventJson'] as String,
    );
  }

  /// The encrypted outer event JSON ready to publish to relays.
  final String outerEventJson;

  /// The original inner event JSON (plaintext message as event).
  final String innerEventJson;

  Map<String, dynamic> toMap() {
    return {
      'outerEventJson': outerEventJson,
      'innerEventJson': innerEventJson,
    };
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    return other is SendResult &&
        other.outerEventJson == outerEventJson &&
        other.innerEventJson == innerEventJson;
  }

  @override
  int get hashCode => outerEventJson.hashCode ^ innerEventJson.hashCode;
}

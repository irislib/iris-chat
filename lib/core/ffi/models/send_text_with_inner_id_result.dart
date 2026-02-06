/// Result of sending a text message via SessionManager including the stable inner (rumor) id.
class SendTextWithInnerIdResult {
  const SendTextWithInnerIdResult({
    required this.innerId,
    required this.outerEventIds,
  });

  factory SendTextWithInnerIdResult.fromMap(Map<String, dynamic> map) {
    return SendTextWithInnerIdResult(
      innerId: map['innerId'] as String,
      outerEventIds: (map['outerEventIds'] as List).map((e) => e.toString()).toList(),
    );
  }

  /// Stable inner event id (rumor id).
  final String innerId;

  /// Outer message event ids that were published.
  final List<String> outerEventIds;

  Map<String, dynamic> toMap() {
    return {
      'innerId': innerId,
      'outerEventIds': outerEventIds,
    };
  }
}


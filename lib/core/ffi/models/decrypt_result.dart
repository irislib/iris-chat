/// Result of decrypting a received message.
class DecryptResult {
  const DecryptResult({
    required this.plaintext,
    required this.innerEventJson,
  });

  factory DecryptResult.fromMap(Map<String, dynamic> map) {
    return DecryptResult(
      plaintext: map['plaintext'] as String,
      innerEventJson: map['innerEventJson'] as String,
    );
  }

  /// The decrypted plaintext content.
  final String plaintext;

  /// The inner event JSON (parsed or wrapped plaintext).
  final String innerEventJson;

  Map<String, dynamic> toMap() {
    return {
      'plaintext': plaintext,
      'innerEventJson': innerEventJson,
    };
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    return other is DecryptResult &&
        other.plaintext == plaintext &&
        other.innerEventJson == innerEventJson;
  }

  @override
  int get hashCode => plaintext.hashCode ^ innerEventJson.hashCode;
}

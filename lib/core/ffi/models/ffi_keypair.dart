/// A keypair with hex-encoded keys.
class FfiKeyPair {
  const FfiKeyPair({
    required this.publicKeyHex,
    required this.privateKeyHex,
  });

  factory FfiKeyPair.fromMap(Map<String, dynamic> map) {
    return FfiKeyPair(
      publicKeyHex: map['publicKeyHex'] as String,
      privateKeyHex: map['privateKeyHex'] as String,
    );
  }

  /// The public key as a 64-character hex string.
  final String publicKeyHex;

  /// The private key as a 64-character hex string.
  final String privateKeyHex;

  Map<String, dynamic> toMap() {
    return {
      'publicKeyHex': publicKeyHex,
      'privateKeyHex': privateKeyHex,
    };
  }

  /// Validates that both keys are valid 64-character hex strings.
  bool get isValid {
    return _isValidHex(publicKeyHex) && _isValidHex(privateKeyHex);
  }

  static bool _isValidHex(String hex) {
    if (hex.length != 64) return false;
    return RegExp(r'^[0-9a-fA-F]+$').hasMatch(hex);
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    return other is FfiKeyPair &&
        other.publicKeyHex == publicKeyHex &&
        other.privateKeyHex == privateKeyHex;
  }

  @override
  int get hashCode => publicKeyHex.hashCode ^ privateKeyHex.hashCode;

  @override
  String toString() => 'FfiKeyPair(pubkey: ${publicKeyHex.substring(0, 8)}...)';
}

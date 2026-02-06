/// FFI-friendly device entry for AppKeys.
///
/// Matches Rust `FfiDeviceEntry`.
class FfiDeviceEntry {
  const FfiDeviceEntry({
    required this.identityPubkeyHex,
    required this.createdAt,
  });

  factory FfiDeviceEntry.fromMap(Map<String, dynamic> map) {
    return FfiDeviceEntry(
      identityPubkeyHex: map['identityPubkeyHex'] as String,
      createdAt: (map['createdAt'] as num).toInt(),
    );
  }

  /// Device identity public key (hex).
  final String identityPubkeyHex;

  /// Unix timestamp (seconds) when the device entry was created.
  final int createdAt;

  Map<String, dynamic> toMap() {
    return {
      'identityPubkeyHex': identityPubkeyHex,
      'createdAt': createdAt,
    };
  }
}


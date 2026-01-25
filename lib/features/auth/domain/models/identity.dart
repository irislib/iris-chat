import 'package:freezed_annotation/freezed_annotation.dart';

part 'identity.freezed.dart';
part 'identity.g.dart';

/// Represents the user's Nostr identity.
@freezed
class Identity with _$Identity {
  const factory Identity({
    /// The public key as a 64-character hex string.
    required String pubkeyHex,

    /// Optional display name.
    String? displayName,

    /// When the identity was created.
    DateTime? createdAt,
  }) = _Identity;

  factory Identity.fromJson(Map<String, dynamic> json) =>
      _$IdentityFromJson(json);
}

/// Exception thrown when key validation fails.
class InvalidKeyException implements Exception {
  const InvalidKeyException(this.message);

  final String message;

  @override
  String toString() => 'InvalidKeyException: $message';
}

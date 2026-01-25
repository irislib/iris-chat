import 'package:freezed_annotation/freezed_annotation.dart';

part 'invite.freezed.dart';
part 'invite.g.dart';

/// Represents a chat invite that can be shared.
@freezed
class Invite with _$Invite {
  const factory Invite({
    /// Unique identifier for this invite.
    required String id,

    /// The inviter's public key as hex.
    required String inviterPubkeyHex,

    /// Optional label for organizing invites.
    String? label,

    /// When the invite was created.
    required DateTime createdAt,

    /// Maximum number of times this invite can be used.
    int? maxUses,

    /// Number of times this invite has been used.
    @Default(0) int useCount,

    /// List of pubkeys that have accepted this invite.
    @Default([]) List<String> acceptedBy,

    /// Serialized invite state for persistence.
    String? serializedState,
  }) = _Invite;

  const Invite._();

  factory Invite.fromJson(Map<String, dynamic> json) => _$InviteFromJson(json);

  /// Check if the invite can still be used.
  bool get canBeUsed => maxUses == null || useCount < maxUses!;

  /// Check if the invite has been used.
  bool get isUsed => useCount > 0;
}

/// Result of accepting an invite.
@freezed
class InviteAcceptData with _$InviteAcceptData {
  const factory InviteAcceptData({
    /// The created session ID.
    required String sessionId,

    /// The response event JSON to publish.
    required String responseEventJson,

    /// The inviter's public key.
    required String inviterPubkeyHex,
  }) = _InviteAcceptData;

  factory InviteAcceptData.fromJson(Map<String, dynamic> json) =>
      _$InviteAcceptDataFromJson(json);
}

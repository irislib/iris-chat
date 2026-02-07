import 'package:freezed_annotation/freezed_annotation.dart';

part 'group.freezed.dart';
part 'group.g.dart';

/// Represents a private group chat.
///
/// Groups are coordinated via encrypted "rumors" tagged with `["l", groupId]`
/// and a metadata rumor (kind 40) whose content is JSON.
@freezed
abstract class ChatGroup with _$ChatGroup {
  const factory ChatGroup({
    /// Unique identifier for this group.
    required String id,

    /// Human-readable group name.
    required String name,

    /// Optional description shown in group info.
    String? description,

    /// Optional picture URL.
    String? picture,

    /// Member identity pubkeys (hex).
    required List<String> members,

    /// Admin identity pubkeys (hex).
    required List<String> admins,

    /// Group creation timestamp.
    required DateTime createdAt,

    /// 32-byte hex secret used by SharedChannel (optional; may be omitted for removed members).
    String? secret,

    /// Whether the local user has accepted the invitation.
    @Default(false) bool accepted,

    /// When the last message was sent/received.
    DateTime? lastMessageAt,

    /// Preview of the last message.
    String? lastMessagePreview,

    /// Number of unread messages.
    @Default(0) int unreadCount,
  }) = _ChatGroup;

  const ChatGroup._();

  factory ChatGroup.fromJson(Map<String, dynamic> json) =>
      _$ChatGroupFromJson(json);
}


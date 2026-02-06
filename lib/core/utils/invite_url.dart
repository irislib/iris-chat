import 'dart:convert';

Map<String, dynamic>? decodeInviteUrlData(String url) {
  try {
    final fragment = Uri.parse(url).fragment;
    if (fragment.isEmpty) return null;
    final decoded = Uri.decodeComponent(fragment);
    final json = jsonDecode(decoded);
    if (json is Map<String, dynamic>) return json;
  } catch (_) {}
  return null;
}

/// Extract the optional invite purpose from an Iris invite URL.
///
/// Expected values: "chat" | "link".
String? extractInvitePurpose(String url) {
  final data = decodeInviteUrlData(url);
  final purpose = data?['purpose'];
  if (purpose is String && purpose.isNotEmpty) return purpose;
  return null;
}

/// Extract the optional owner pubkey (hex) from an Iris invite URL.
String? extractInviteOwnerPubkeyHex(String url) {
  final data = decodeInviteUrlData(url);
  final owner = data?['owner'] ?? data?['ownerPubkey'];
  if (owner is String && owner.isNotEmpty) return owner;
  return null;
}


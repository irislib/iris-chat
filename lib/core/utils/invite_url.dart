import 'dart:convert';

Map<String, dynamic>? decodeInviteUrlData(String url) {
  try {
    final uri = Uri.parse(url);

    // Iris invite URLs have existed in a few forms over time:
    // - `https://iris.to/#%7B...json...%7D`
    // - `https://iris.to/#invite=%7B...json...%7D`
    // - `https://iris.to/#foo=bar&invite=%7B...json...%7D`
    // - `https://iris.to/invite?invite=%7B...json...%7D`
    //
    // Normalize by extracting the JSON payload first, then decoding.
    final candidates = <String>[];

    final fragment = uri.fragment;
    if (fragment.isNotEmpty) {
      candidates.add(fragment);

      // Common prefix: `invite=<payload>`
      if (fragment.startsWith('invite=')) {
        candidates.add(fragment.substring('invite='.length));
      }

      // Some fragments are querystring-like: `foo=bar&invite=<payload>`.
      try {
        final qp = Uri.splitQueryString(fragment);
        final invite = qp['invite'];
        if (invite != null && invite.isNotEmpty) {
          candidates.add(invite);
        }
      } catch (_) {
        // Ignore; fragment may be raw JSON.
      }
    }

    final inviteQuery = uri.queryParameters['invite'];
    if (inviteQuery != null && inviteQuery.isNotEmpty) {
      candidates.add(inviteQuery);
    }

    for (final raw in candidates) {
      var payload = raw;
      if (payload.isEmpty) continue;

      payload = Uri.decodeComponent(payload).trim();
      if (payload.isEmpty) continue;

      if (payload.startsWith('invite=')) {
        payload = payload.substring('invite='.length).trim();
        if (payload.isEmpty) continue;
      }

      // If the payload still looks like a querystring, extract `invite=...` again.
      if (!payload.startsWith('{')) {
        try {
          final qp = Uri.splitQueryString(payload);
          final invite = qp['invite'];
          if (invite != null && invite.isNotEmpty) {
            payload = invite.trim();
          }
        } catch (_) {}
      }

      final decoded = jsonDecode(payload);
      if (decoded is Map<String, dynamic>) {
        final inner = decoded['invite'];
        if (inner is Map<String, dynamic>) return inner;
        return decoded;
      }
    }
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

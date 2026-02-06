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

/// Whether [url] looks like an Iris invite URL that we can accept.
///
/// This is used to avoid sending obviously-non-invite URLs to the native parser,
/// which tends to produce confusing errors for users.
bool looksLikeInviteUrl(String url) {
  final uri = Uri.tryParse(url);
  if (uri == null) return false;

  // JSON-based invites in fragment/query.
  if (decodeInviteUrlData(url) != null) return true;

  final path = uri.path.toLowerCase();
  if (path.contains('/invite')) return true;

  final qp = uri.queryParameters;
  // Legacy format: /invite?id=...&secret=...
  if (qp.containsKey('id') && qp.containsKey('secret')) return true;

  // Fragment-based legacy: /#invite=...
  final frag = uri.fragment.toLowerCase();
  if (frag.startsWith('invite=')) return true;

  return false;
}

/// Best-effort detection of a Nostr bech32 identity/profile link.
bool looksLikeNostrIdentityLink(String input) {
  final s = input.toLowerCase();
  return s.contains('npub1') ||
      s.contains('nprofile1') ||
      s.startsWith('nostr:npub1') ||
      s.startsWith('nostr:nprofile1');
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

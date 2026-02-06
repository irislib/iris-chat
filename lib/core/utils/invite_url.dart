import 'dart:convert';

import 'package:nostr/nostr.dart' as nostr;

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
  return extractNostrIdentityPubkeyHex(input) != null;
}

/// Extract a Nostr identity pubkey (hex) from a bech32 `npub` or `nprofile` link.
///
/// Supports common input formats:
/// - `npub1...`
/// - `nostr:npub1...`
/// - `https://chat.iris.to/#npub1...`
/// - `https://chat.iris.to/#/npub1...` (hash-routing style)
///
/// Returns `null` if no valid identity is found.
String? extractNostrIdentityPubkeyHex(String input) {
  final bech32 = _extractNostrBech32Identity(input);
  if (bech32 == null) return null;

  final s = bech32.toLowerCase();

  if (s.startsWith('npub1')) {
    try {
      final hex = nostr.Nip19.decodePubkey(s).toLowerCase();
      if (_looksLikeHexPubkey(hex)) return hex;
    } catch (_) {}
    return null;
  }

  if (s.startsWith('nprofile1')) {
    try {
      final decoded = nostr.bech32Decode(s);
      if (decoded['prefix'] != 'nprofile') return null;
      final dataHex = decoded['data'];
      if (dataHex == null || dataHex.isEmpty) return null;

      final bytes = _hexToBytes(dataHex);
      final pubkeyHex = _parseNprofilePubkeyHex(bytes);
      if (pubkeyHex == null) return null;
      final normalized = pubkeyHex.toLowerCase();
      if (_looksLikeHexPubkey(normalized)) return normalized;
    } catch (_) {}
    return null;
  }

  return null;
}

String? _extractNostrBech32Identity(String input) {
  final trimmed = input.trim();
  if (trimmed.isEmpty) return null;

  // Common format: `nostr:npub1...`
  var s = trimmed;
  if (s.toLowerCase().startsWith('nostr:')) {
    s = s.substring('nostr:'.length);
  }

  // Most robust: find `npub1...` / `nprofile1...` anywhere in the string
  // (covers URL fragments, pasted text, and QR contents).
  const pattern = '(npub1[0-9a-z]+|nprofile1[0-9a-z]+)';
  final re = RegExp(pattern, caseSensitive: false);

  final match = re.firstMatch(s);
  if (match != null) return match.group(1);

  // Best-effort: try with percent-decoding (some apps encode the whole link).
  try {
    final decoded = Uri.decodeFull(s);
    final match2 = re.firstMatch(decoded);
    if (match2 != null) return match2.group(1);
  } catch (_) {}

  return null;
}

bool _looksLikeHexPubkey(String hex) {
  if (hex.length != 64) return false;
  for (var i = 0; i < hex.length; i++) {
    final c = hex.codeUnitAt(i);
    final isDigit = c >= 48 && c <= 57;
    final isLowerAF = c >= 97 && c <= 102;
    final isUpperAF = c >= 65 && c <= 70;
    if (!(isDigit || isLowerAF || isUpperAF)) return false;
  }
  return true;
}

List<int> _hexToBytes(String hex) {
  final s = hex.trim();
  if (s.length.isOdd) {
    throw const FormatException('Invalid hex: odd length');
  }
  final out = <int>[];
  for (var i = 0; i < s.length; i += 2) {
    final byte = int.parse(s.substring(i, i + 2), radix: 16);
    out.add(byte);
  }
  return out;
}

String _bytesToHex(List<int> bytes) {
  final b = StringBuffer();
  for (final v in bytes) {
    b.write(v.toRadixString(16).padLeft(2, '0'));
  }
  return b.toString();
}

String? _parseNprofilePubkeyHex(List<int> bytes) {
  // NIP-19 nprofile: TLV entries. We only need type=0 (32-byte pubkey).
  var i = 0;
  while (i + 2 <= bytes.length) {
    final t = bytes[i];
    final l = bytes[i + 1];
    i += 2;
    if (i + l > bytes.length) return null;
    final v = bytes.sublist(i, i + l);
    i += l;
    if (t == 0 && l == 32) {
      return _bytesToHex(v);
    }
  }
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

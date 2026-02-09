import 'dart:convert';

/// Minimal parsed representation of an unsigned inner event ("rumor") used by nostr-double-ratchet.
class NostrRumor {
  const NostrRumor({
    required this.id,
    required this.pubkey,
    required this.createdAt,
    required this.kind,
    required this.content,
    required this.tags,
  });

  factory NostrRumor.fromJsonMap(Map<String, dynamic> map) {
    return NostrRumor(
      id: map['id'] as String,
      pubkey: map['pubkey'] as String,
      createdAt: (map['created_at'] as num).toInt(),
      kind: (map['kind'] as num).toInt(),
      content: map['content'] as String? ?? '',
      tags: (map['tags'] as List? ?? const [])
          .map((t) => (t as List).map((e) => e.toString()).toList())
          .toList(),
    );
  }

  static NostrRumor? tryParse(String jsonString) {
    try {
      final decoded = jsonDecode(jsonString);
      if (decoded is! Map<String, dynamic>) return null;
      if (!decoded.containsKey('id') || !decoded.containsKey('pubkey')) {
        return null;
      }
      return NostrRumor.fromJsonMap(decoded);
    } catch (_) {
      return null;
    }
  }

  final String id;
  final String pubkey;
  final int createdAt;
  final int kind;
  final String content;
  final List<List<String>> tags;
}

String? getFirstTagValue(List<List<String>> tags, String name) {
  for (final t in tags) {
    if (t.isEmpty) continue;
    if (t[0] != name) continue;
    if (t.length < 2) return null;
    return t[1];
  }
  return null;
}

List<String> getTagValues(List<List<String>> tags, String name) {
  final out = <String>[];
  for (final t in tags) {
    if (t.isEmpty) continue;
    if (t[0] != name) continue;
    if (t.length < 2) continue;
    out.add(t[1]);
  }
  return out;
}

/// Extract a NIP-40 expiration timestamp (unix seconds) from tags.
///
/// Tag format: `["expiration", "<unix seconds>"]`
int? getExpirationTimestampSeconds(List<List<String>> tags) {
  final raw = getFirstTagValue(tags, 'expiration');
  if (raw == null || raw.isEmpty) return null;
  final v = int.tryParse(raw);
  if (v == null || v <= 0) return null;
  return v;
}

int? getMillisecondTimestamp(List<List<String>> tags) {
  final ms = getFirstTagValue(tags, 'ms');
  if (ms == null) return null;
  return int.tryParse(ms);
}

DateTime rumorTimestamp(NostrRumor rumor) {
  final ms = getMillisecondTimestamp(rumor.tags);
  if (ms != null) {
    return DateTime.fromMillisecondsSinceEpoch(ms);
  }
  return DateTime.fromMillisecondsSinceEpoch(rumor.createdAt * 1000);
}

/// Resolve the conversation peer pubkey for a rumor.
///
/// If the rumor's pubkey matches our owner pubkey (self-sync/outgoing copies),
/// we use the first `p` tag as the actual peer. Otherwise the peer is the sender pubkey.
String? resolveRumorPeerPubkey({
  required String ownerPubkeyHex,
  required NostrRumor rumor,
}) {
  if (rumor.pubkey == ownerPubkeyHex) {
    return getFirstTagValue(rumor.tags, 'p');
  }
  return rumor.pubkey;
}

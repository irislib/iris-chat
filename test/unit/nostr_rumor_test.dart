import 'package:flutter_test/flutter_test.dart';

import 'package:iris_chat/core/utils/nostr_rumor.dart';

void main() {
  test('parses rumor and extracts tags', () {
    const json = '''
{
  "id":"abc",
  "pubkey":"alice",
  "created_at":123,
  "kind":14,
  "content":"hi",
  "tags":[["p","bob"],["ms","1700000000000"],["e","msg1"],["e","msg2"]]
}
''';

    final rumor = NostrRumor.tryParse(json);
    expect(rumor, isNotNull);
    expect(rumor!.id, 'abc');
    expect(rumor.kind, 14);
    expect(getFirstTagValue(rumor.tags, 'p'), 'bob');
    expect(getTagValues(rumor.tags, 'e'), ['msg1', 'msg2']);
    expect(getMillisecondTimestamp(rumor.tags), 1700000000000);
  });

  test('resolveRumorPeerPubkey uses p tag for self rumors', () {
    final rumor = NostrRumor.fromJsonMap({
      'id': 'abc',
      'pubkey': 'me',
      'created_at': 1,
      'kind': 14,
      'content': 'hi',
      'tags': [
        ['p', 'peer'],
      ],
    });

    expect(resolveRumorPeerPubkey(ownerPubkeyHex: 'me', rumor: rumor), 'peer');
  });

  test('resolveRumorPeerPubkey uses sender pubkey for remote rumors', () {
    final rumor = NostrRumor.fromJsonMap({
      'id': 'abc',
      'pubkey': 'peer',
      'created_at': 1,
      'kind': 14,
      'content': 'hi',
      'tags': [
        ['p', 'me'],
      ],
    });

    expect(resolveRumorPeerPubkey(ownerPubkeyHex: 'me', rumor: rumor), 'peer');
  });
}

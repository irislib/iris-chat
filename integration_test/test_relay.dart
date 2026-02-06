import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// Minimal in-process Nostr relay for integration tests.
///
/// Supports:
/// - `REQ` with one or more filters
/// - `EVENT` publish with broadcast fan-out to matching subscriptions
/// - `EOSE` and minimal `OK` acks
/// - `CLOSE` subscription close
class TestRelay {
  TestRelay._(this._server);

  final HttpServer _server;
  final Set<WebSocket> _sockets = <WebSocket>{};
  final Map<WebSocket, Map<String, List<Map<String, dynamic>>>> _subs =
      <WebSocket, Map<String, List<Map<String, dynamic>>>>{};
  final List<Map<String, dynamic>> _events = <Map<String, dynamic>>[];

  int get port => _server.port;

  /// Snapshot of all events published to this relay (in receive order).
  List<Map<String, dynamic>> get events =>
      List<Map<String, dynamic>>.from(_events);

  /// Whether any connected client currently has an active subscription that
  /// includes `kind` and a `#p` tag filter containing `pTagValue`.
  bool hasKindAndPTagSubscription({
    required int kind,
    required String pTagValue,
  }) {
    for (final subsById in _subs.values) {
      for (final filters in subsById.values) {
        for (final f in filters) {
          final kinds = f['kinds'];
          if (kinds is! List) continue;
          final hasKind = kinds.any(
            (k) => k is num ? k.toInt() == kind : false,
          );
          if (!hasKind) continue;

          final p = f['#p'];
          if (p is! List) continue;
          final hasP = p.any((v) => v.toString() == pTagValue);
          if (!hasP) continue;

          return true;
        }
      }
    }
    return false;
  }

  static Future<TestRelay> start() async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final relay = TestRelay._(server);
    unawaited(relay._serve());
    return relay;
  }

  Future<void> _serve() async {
    await for (final req in _server) {
      if (!WebSocketTransformer.isUpgradeRequest(req)) {
        req.response.statusCode = HttpStatus.badRequest;
        await req.response.close();
        continue;
      }

      final ws = await WebSocketTransformer.upgrade(req);
      _sockets.add(ws);
      _subs[ws] = <String, List<Map<String, dynamic>>>{};

      ws.listen(
        (data) => _handle(ws, data),
        onDone: () {
          _sockets.remove(ws);
          _subs.remove(ws);
        },
        onError: (_) {
          _sockets.remove(ws);
          _subs.remove(ws);
        },
      );
    }
  }

  void _handle(WebSocket ws, dynamic data) {
    if (data is! String) return;
    final decoded = jsonDecode(data);
    if (decoded is! List || decoded.isEmpty) return;

    final type = decoded[0];
    if (type is! String) return;

    switch (type) {
      case 'REQ':
        if (decoded.length < 3) return;
        final subId = decoded[1];
        if (subId is! String) return;

        // Support multiple filters: ["REQ", subid, {filter}, {filter2}, ...]
        final filters = <Map<String, dynamic>>[];
        for (var i = 2; i < decoded.length; i++) {
          final f = decoded[i];
          if (f is Map) {
            filters.add(Map<String, dynamic>.from(f));
          }
        }
        _subs[ws]?[subId] = filters;

        // Send stored events that match immediately (basic relay behavior).
        final matched = <Map<String, dynamic>>[];
        for (final e in _events) {
          if (_matchesAny(e, filters)) {
            matched.add(e);
          }
        }
        for (final e in matched) {
          ws.add(jsonEncode(['EVENT', subId, e]));
        }
        ws.add(jsonEncode(['EOSE', subId]));
        break;
      case 'CLOSE':
        if (decoded.length < 2) return;
        final subId = decoded[1];
        if (subId is! String) return;
        _subs[ws]?.remove(subId);
        break;
      case 'EVENT':
        if (decoded.length < 2) return;
        final event = decoded[1];
        if (event is! Map) return;
        final eventMap = Map<String, dynamic>.from(event);
        _events.add(eventMap);

        // Minimal OK ack.
        final id = eventMap['id'];
        if (id is String) {
          ws.add(jsonEncode(['OK', id, true, '']));
        }

        _broadcast(eventMap);
        break;
    }
  }

  void _broadcast(Map<String, dynamic> event) {
    for (final sock in _sockets) {
      final subs = _subs[sock];
      if (subs == null) continue;

      for (final entry in subs.entries) {
        final subId = entry.key;
        final filters = entry.value;

        if (_matchesAny(event, filters)) {
          sock.add(jsonEncode(['EVENT', subId, event]));
        }
      }
    }
  }

  bool _matchesAny(
    Map<String, dynamic> event,
    List<Map<String, dynamic>> filters,
  ) {
    for (final f in filters) {
      if (_matchesFilter(event, f)) return true;
    }
    return false;
  }

  bool _matchesFilter(Map<String, dynamic> event, Map<String, dynamic> filter) {
    final kind = event['kind'];
    final pubkey = event['pubkey'];
    final createdAt = event['created_at'];

    if (filter.containsKey('kinds')) {
      final kinds = filter['kinds'];
      if (kinds is List && kind is num) {
        final k = kind.toInt();
        if (!kinds.map((e) => (e as num).toInt()).contains(k)) return false;
      }
    }

    if (filter.containsKey('authors')) {
      final authors = filter['authors'];
      if (authors is List && pubkey is String) {
        if (!authors.map((e) => e.toString()).contains(pubkey)) return false;
      }
    }

    if (filter.containsKey('since')) {
      final since = filter['since'];
      if (since is num && createdAt is num) {
        if (createdAt.toInt() < since.toInt()) return false;
      }
    }

    if (filter.containsKey('until')) {
      final until = filter['until'];
      if (until is num && createdAt is num) {
        if (createdAt.toInt() > until.toInt()) return false;
      }
    }

    // Tag filters: '#p', '#e', '#d', '#l', etc.
    final tags = event['tags'];
    for (final entry in filter.entries) {
      final k = entry.key;
      if (!k.startsWith('#') || k.length < 2) continue;
      final v = entry.value;
      if (v is! List) continue;
      if (tags is! List) return false;

      final tagName = k.substring(1);
      final values = v.map((e) => e.toString()).toSet();
      if (!_hasTag(tags, tagName, values)) return false;
    }

    return true;
  }

  bool _hasTag(List tags, String name, Set<String> values) {
    for (final t in tags) {
      if (t is! List || t.length < 2) continue;
      if (t[0] != name) continue;
      final v = t[1]?.toString();
      if (v != null && values.contains(v)) return true;
    }
    return false;
  }

  Future<void> stop() async {
    for (final ws in _sockets.toList()) {
      try {
        await ws.close();
      } catch (_) {}
    }
    _sockets.clear();
    _subs.clear();
    _events.clear();
    await _server.close(force: true);
  }
}

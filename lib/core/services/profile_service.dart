import 'dart:async';
import 'dart:convert';

import 'logger_service.dart';
import 'nostr_service.dart';

/// Service for fetching and caching Nostr profiles (kind 0 metadata).
class ProfileService {
  ProfileService(this._nostrService);

  final NostrService _nostrService;
  final Map<String, NostrProfile> _cache = {};
  final Map<String, Completer<NostrProfile?>> _pendingRequests = {};
  String? _subscriptionId;
  StreamSubscription<NostrEvent>? _eventSubscription;

  static const int _metadataKind = 0;

  /// Get a profile from cache or fetch from relays.
  Future<NostrProfile?> getProfile(String pubkey) async {
    // Check cache first
    if (_cache.containsKey(pubkey)) {
      return _cache[pubkey];
    }

    // Check if already fetching
    if (_pendingRequests.containsKey(pubkey)) {
      return _pendingRequests[pubkey]!.future;
    }

    // Start fetching
    final completer = Completer<NostrProfile?>();
    _pendingRequests[pubkey] = completer;

    _fetchProfile(pubkey);

    // Timeout after 5 seconds
    return completer.future.timeout(
      const Duration(seconds: 5),
      onTimeout: () {
        _pendingRequests.remove(pubkey);
        return null;
      },
    );
  }

  /// Fetch profiles for multiple pubkeys.
  Future<void> fetchProfiles(List<String> pubkeys) async {
    final toFetch = pubkeys.where((pk) => !_cache.containsKey(pk)).toList();
    if (toFetch.isEmpty) return;

    // Cancel existing subscription
    if (_subscriptionId != null) {
      _nostrService.closeSubscription(_subscriptionId!);
    }
    await _eventSubscription?.cancel();

    // Subscribe to metadata events
    _eventSubscription = _nostrService.events.listen(_handleEvent);

    _subscriptionId = _nostrService.subscribe(
      NostrFilter(
        kinds: [_metadataKind],
        authors: toFetch,
        limit: toFetch.length,
      ),
    );

    Logger.debug(
      'Fetching profiles',
      category: LogCategory.nostr,
      data: {'pubkeyCount': toFetch.length},
    );
  }

  void _fetchProfile(String pubkey) {
    // Cancel existing subscription
    if (_subscriptionId != null) {
      _nostrService.closeSubscription(_subscriptionId!);
    }

    // Setup listener if not already
    _eventSubscription ??= _nostrService.events.listen(_handleEvent);

    _subscriptionId = _nostrService.subscribe(
      NostrFilter(
        kinds: [_metadataKind],
        authors: [pubkey],
        limit: 1,
      ),
    );
  }

  void _handleEvent(NostrEvent event) {
    if (event.kind != _metadataKind) return;

    try {
      final metadata = jsonDecode(event.content) as Map<String, dynamic>;
      final profile = NostrProfile(
        pubkey: event.pubkey,
        name: metadata['name'] as String?,
        displayName: metadata['display_name'] as String?,
        picture: metadata['picture'] as String?,
        about: metadata['about'] as String?,
        nip05: metadata['nip05'] as String?,
        updatedAt: DateTime.fromMillisecondsSinceEpoch(event.createdAt * 1000),
      );

      // Update cache (keep most recent)
      final existing = _cache[event.pubkey];
      if (existing == null || profile.updatedAt.isAfter(existing.updatedAt)) {
        _cache[event.pubkey] = profile;
      }

      // Complete pending request
      final completer = _pendingRequests.remove(event.pubkey);
      if (completer != null && !completer.isCompleted) {
        completer.complete(_cache[event.pubkey]);
      }

      Logger.debug(
        'Profile fetched',
        category: LogCategory.nostr,
        data: {
          'pubkey': event.pubkey.substring(0, 8),
          'name': profile.bestName,
        },
      );
    } catch (e) {
      Logger.error(
        'Failed to parse profile',
        category: LogCategory.nostr,
        error: e,
        data: {'pubkey': event.pubkey.substring(0, 8)},
      );
    }
  }

  /// Get cached profile (synchronous).
  NostrProfile? getCachedProfile(String pubkey) => _cache[pubkey];

  /// Clear the cache.
  void clearCache() => _cache.clear();

  /// Dispose of the service.
  Future<void> dispose() async {
    if (_subscriptionId != null) {
      _nostrService.closeSubscription(_subscriptionId!);
    }
    await _eventSubscription?.cancel();
    _cache.clear();
    _pendingRequests.clear();
  }
}

/// Nostr profile from kind 0 metadata.
class NostrProfile {
  const NostrProfile({
    required this.pubkey,
    this.name,
    this.displayName,
    this.picture,
    this.about,
    this.nip05,
    required this.updatedAt,
  });

  final String pubkey;
  final String? name;
  final String? displayName;
  final String? picture;
  final String? about;
  final String? nip05;
  final DateTime updatedAt;

  /// Get the best available name (display_name > name).
  String? get bestName {
    if (displayName != null && displayName!.trim().isNotEmpty) {
      return displayName!.trim();
    }
    if (name != null && name!.trim().isNotEmpty) {
      return name!.trim();
    }
    return null;
  }
}

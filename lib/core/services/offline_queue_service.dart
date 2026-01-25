import 'dart:async';
import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'connectivity_service.dart';
import 'logger_service.dart';

/// Service for managing offline message queue.
///
/// When offline, messages are queued and persisted to storage.
/// When back online, queued messages are sent automatically.
class OfflineQueueService {
  OfflineQueueService({
    required ConnectivityService connectivityService,
    required Future<void> Function(QueuedMessage) sendMessage,
    SharedPreferences? prefs,
  })  : _connectivityService = connectivityService,
        _sendMessage = sendMessage,
        _prefs = prefs;

  final ConnectivityService _connectivityService;
  final Future<void> Function(QueuedMessage) _sendMessage;
  SharedPreferences? _prefs;

  final List<QueuedMessage> _queue = [];
  final _queueController = StreamController<List<QueuedMessage>>.broadcast();
  StreamSubscription<ConnectivityStatus>? _connectivitySubscription;

  bool _disposed = false;
  bool _isSyncing = false;

  static const _queueKey = 'iris_chat_offline_queue';

  /// Stream of queue changes.
  Stream<List<QueuedMessage>> get queueStream => _queueController.stream;

  /// Current queue.
  List<QueuedMessage> get queue => List.unmodifiable(_queue);

  /// Number of queued messages.
  int get queueLength => _queue.length;

  /// Whether there are queued messages.
  bool get hasQueuedMessages => _queue.isNotEmpty;

  /// Whether currently syncing.
  bool get isSyncing => _isSyncing;

  /// Initialize the service.
  Future<void> initialize() async {
    if (_disposed) return;

    Logger.info('Initializing OfflineQueueService', category: LogCategory.app);

    // Load persisted queue
    _prefs ??= await SharedPreferences.getInstance();
    await _loadQueue();

    // Listen for connectivity changes
    _connectivitySubscription = _connectivityService.statusStream.listen(
      _handleConnectivityChange,
    );

    // If already online and have queued messages, start syncing
    if (_connectivityService.isOnline && _queue.isNotEmpty) {
      unawaited(_syncQueue());
    }
  }

  Future<void> _loadQueue() async {
    try {
      final json = _prefs?.getString(_queueKey);
      if (json != null) {
        final list = jsonDecode(json) as List<dynamic>;
        _queue.clear();
        _queue.addAll(
          list.map((e) => QueuedMessage.fromJson(e as Map<String, dynamic>)),
        );

        Logger.info(
          'Loaded offline queue',
          category: LogCategory.app,
          data: {'count': _queue.length},
        );

        _notifyQueue();
      }
    } catch (e, st) {
      Logger.error(
        'Failed to load offline queue',
        category: LogCategory.app,
        error: e,
        stackTrace: st,
      );
    }
  }

  Future<void> _saveQueue() async {
    try {
      final json = jsonEncode(_queue.map((m) => m.toJson()).toList());
      await _prefs?.setString(_queueKey, json);
    } catch (e, st) {
      Logger.error(
        'Failed to save offline queue',
        category: LogCategory.app,
        error: e,
        stackTrace: st,
      );
    }
  }

  void _handleConnectivityChange(ConnectivityStatus status) {
    if (status == ConnectivityStatus.online && _queue.isNotEmpty) {
      Logger.info(
        'Back online, syncing queued messages',
        category: LogCategory.app,
        data: {'queueLength': _queue.length},
      );
      _syncQueue();
    }
  }

  /// Add a message to the queue.
  Future<void> enqueue(QueuedMessage message) async {
    if (_disposed) return;

    Logger.debug(
      'Enqueueing message',
      category: LogCategory.app,
      data: {'messageId': message.id, 'sessionId': message.sessionId},
    );

    _queue.add(message);
    await _saveQueue();
    _notifyQueue();

    // If online, try to send immediately
    if (_connectivityService.isOnline) {
      unawaited(_syncQueue());
    }
  }

  /// Remove a message from the queue.
  Future<void> dequeue(String messageId) async {
    _queue.removeWhere((m) => m.id == messageId);
    await _saveQueue();
    _notifyQueue();
  }

  /// Sync all queued messages.
  Future<void> _syncQueue() async {
    if (_disposed || _isSyncing || _queue.isEmpty) return;

    _isSyncing = true;
    _notifyQueue();

    Logger.info(
      'Syncing offline queue',
      category: LogCategory.app,
      data: {'count': _queue.length},
    );

    // Process queue in order
    final toProcess = List<QueuedMessage>.from(_queue);

    for (final message in toProcess) {
      if (_disposed || !_connectivityService.isOnline) break;

      try {
        await _sendMessage(message);
        await dequeue(message.id);

        Logger.debug(
          'Sent queued message',
          category: LogCategory.app,
          data: {'messageId': message.id},
        );
      } catch (e, st) {
        Logger.error(
          'Failed to send queued message',
          category: LogCategory.app,
          error: e,
          stackTrace: st,
          data: {'messageId': message.id, 'retryCount': message.retryCount},
        );

        // Update retry count
        final index = _queue.indexWhere((m) => m.id == message.id);
        if (index >= 0) {
          _queue[index] = message.copyWith(
            retryCount: message.retryCount + 1,
            lastAttempt: DateTime.now(),
          );
          await _saveQueue();
        }

        // If too many retries, mark as failed but keep in queue for manual retry
        if (message.retryCount >= 3) {
          Logger.warning(
            'Message exceeded retry limit',
            category: LogCategory.app,
            data: {'messageId': message.id},
          );
        }
      }
    }

    _isSyncing = false;
    _notifyQueue();

    Logger.info(
      'Queue sync complete',
      category: LogCategory.app,
      data: {'remaining': _queue.length},
    );
  }

  /// Manually retry sending queued messages.
  Future<void> retryAll() async {
    if (_connectivityService.isOnline) {
      await _syncQueue();
    }
  }

  /// Clear all queued messages.
  Future<void> clearQueue() async {
    _queue.clear();
    await _saveQueue();
    _notifyQueue();
  }

  void _notifyQueue() {
    if (!_disposed) {
      _queueController.add(List.unmodifiable(_queue));
    }
  }

  /// Dispose of the service.
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;

    Logger.info('Disposing OfflineQueueService', category: LogCategory.app);

    await _connectivitySubscription?.cancel();
    _connectivitySubscription = null;
    await _queueController.close();
  }
}

/// A message queued for sending when back online.
class QueuedMessage {
  const QueuedMessage({
    required this.id,
    required this.sessionId,
    required this.text,
    required this.createdAt,
    this.retryCount = 0,
    this.lastAttempt,
  });

  factory QueuedMessage.fromJson(Map<String, dynamic> json) {
    return QueuedMessage(
      id: json['id'] as String,
      sessionId: json['sessionId'] as String,
      text: json['text'] as String,
      createdAt: DateTime.parse(json['createdAt'] as String),
      retryCount: json['retryCount'] as int? ?? 0,
      lastAttempt: json['lastAttempt'] != null
          ? DateTime.parse(json['lastAttempt'] as String)
          : null,
    );
  }

  final String id;
  final String sessionId;
  final String text;
  final DateTime createdAt;
  final int retryCount;
  final DateTime? lastAttempt;

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'sessionId': sessionId,
      'text': text,
      'createdAt': createdAt.toIso8601String(),
      'retryCount': retryCount,
      if (lastAttempt != null) 'lastAttempt': lastAttempt!.toIso8601String(),
    };
  }

  QueuedMessage copyWith({
    String? id,
    String? sessionId,
    String? text,
    DateTime? createdAt,
    int? retryCount,
    DateTime? lastAttempt,
  }) {
    return QueuedMessage(
      id: id ?? this.id,
      sessionId: sessionId ?? this.sessionId,
      text: text ?? this.text,
      createdAt: createdAt ?? this.createdAt,
      retryCount: retryCount ?? this.retryCount,
      lastAttempt: lastAttempt ?? this.lastAttempt,
    );
  }
}

import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';

import 'logger_service.dart';

/// Service for monitoring network connectivity.
class ConnectivityService {
  ConnectivityService([Connectivity? connectivity])
      : _connectivity = connectivity ?? Connectivity();

  final Connectivity _connectivity;
  final _statusController = StreamController<ConnectivityStatus>.broadcast();
  StreamSubscription<List<ConnectivityResult>>? _subscription;

  ConnectivityStatus _currentStatus = ConnectivityStatus.unknown;
  bool _disposed = false;

  /// Stream of connectivity status changes.
  Stream<ConnectivityStatus> get statusStream => _statusController.stream;

  /// Current connectivity status.
  ConnectivityStatus get currentStatus => _currentStatus;

  /// Whether currently online.
  bool get isOnline => _currentStatus == ConnectivityStatus.online;

  /// Whether currently offline.
  bool get isOffline => _currentStatus == ConnectivityStatus.offline;

  /// Start monitoring connectivity.
  Future<void> startMonitoring() async {
    if (_disposed) return;

    Logger.info('Starting connectivity monitoring', category: LogCategory.app);

    // Check initial status
    await _checkConnectivity();

    // Listen for changes
    _subscription = _connectivity.onConnectivityChanged.listen(
      _handleConnectivityChange,
      onError: (Object error) {
        Logger.error(
          'Connectivity monitoring error',
          category: LogCategory.app,
          error: error,
        );
      },
    );
  }

  Future<void> _checkConnectivity() async {
    try {
      final results = await _connectivity.checkConnectivity();
      _handleConnectivityChange(results);
    } catch (e, st) {
      Logger.error(
        'Failed to check connectivity',
        category: LogCategory.app,
        error: e,
        stackTrace: st,
      );
      _updateStatus(ConnectivityStatus.unknown);
    }
  }

  void _handleConnectivityChange(List<ConnectivityResult> results) {
    final newStatus = _mapResultsToStatus(results);

    if (newStatus != _currentStatus) {
      Logger.info(
        'Connectivity changed',
        category: LogCategory.app,
        data: {
          'from': _currentStatus.name,
          'to': newStatus.name,
          'results': results.map((r) => r.name).toList(),
        },
      );

      _updateStatus(newStatus);
    }
  }

  ConnectivityStatus _mapResultsToStatus(List<ConnectivityResult> results) {
    if (results.isEmpty || results.contains(ConnectivityResult.none)) {
      return ConnectivityStatus.offline;
    }

    // Any connection type means we're online
    if (results.any((r) =>
        r == ConnectivityResult.wifi ||
        r == ConnectivityResult.mobile ||
        r == ConnectivityResult.ethernet)) {
      return ConnectivityStatus.online;
    }

    return ConnectivityStatus.unknown;
  }

  void _updateStatus(ConnectivityStatus status) {
    _currentStatus = status;
    if (!_disposed) {
      _statusController.add(status);
    }
  }

  /// Force a connectivity check.
  Future<void> checkNow() async {
    await _checkConnectivity();
  }

  /// Stop monitoring and release resources.
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;

    Logger.info('Disposing ConnectivityService', category: LogCategory.app);

    await _subscription?.cancel();
    _subscription = null;
    await _statusController.close();
  }
}

/// Connectivity status.
enum ConnectivityStatus {
  /// Device is connected to the internet.
  online,

  /// Device is not connected to the internet.
  offline,

  /// Connectivity status is unknown.
  unknown,
}

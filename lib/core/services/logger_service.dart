/// Logging service for debugging and monitoring.
///
/// Provides structured logging with different severity levels
/// and optional categorization for different parts of the app.
library;

import 'dart:developer' as developer;

import 'package:flutter/foundation.dart';

/// Log levels for filtering output.
enum LogLevel {
  debug,
  info,
  warning,
  error,
}

/// Log categories for organizing output.
enum LogCategory {
  /// General application logs
  app,

  /// Authentication and identity
  auth,

  /// Encryption and cryptographic operations
  crypto,

  /// Invite creation and acceptance
  invite,

  /// Session management
  session,

  /// Message sending and receiving
  message,

  /// Nostr relay communication
  nostr,

  /// Database operations
  database,

  /// FFI/native code interactions
  ffi,
}

/// Centralized logging service.
///
/// Usage:
/// ```dart
/// Logger.debug('Processing message', category: LogCategory.message);
/// Logger.info('Session established', category: LogCategory.session, data: {'id': sessionId});
/// Logger.error('Decryption failed', category: LogCategory.crypto, error: e);
/// ```
class Logger {
  /// Minimum log level to output.
  ///
  /// NOTE: `debugPrint()` is throttled and buffers output; logging at DEBUG level
  /// in a high-throughput path (e.g. Nostr relay events) can build an
  /// unbounded in-memory backlog in debug builds and look like a "memory leak".
  ///
  /// Keep the default at INFO and opt-in to DEBUG when actively debugging.
  static LogLevel minLevel = LogLevel.info;

  /// Whether logging is enabled.
  static bool enabled = true;

  /// Whether to mirror logs to the console via `debugPrint`.
  ///
  /// In debug mode, prefer relying on `developer.log` (shown in DevTools and
  /// usually the flutter run console) and only printing warnings/errors to
  /// avoid `debugPrint` buffering lots of logs in memory.
  static bool printToConsole = kDebugMode;

  /// Category filter - if set, only logs from these categories are output.
  static Set<LogCategory>? categoryFilter;

  /// Debug level log.
  static void debug(
    String message, {
    LogCategory category = LogCategory.app,
    Map<String, dynamic>? data,
  }) {
    _log(LogLevel.debug, message, category: category, data: data);
  }

  /// Info level log.
  static void info(
    String message, {
    LogCategory category = LogCategory.app,
    Map<String, dynamic>? data,
  }) {
    _log(LogLevel.info, message, category: category, data: data);
  }

  /// Warning level log.
  static void warning(
    String message, {
    LogCategory category = LogCategory.app,
    Map<String, dynamic>? data,
    Object? error,
    StackTrace? stackTrace,
  }) {
    _log(
      LogLevel.warning,
      message,
      category: category,
      data: data,
      error: error,
      stackTrace: stackTrace,
    );
  }

  /// Error level log.
  static void error(
    String message, {
    LogCategory category = LogCategory.app,
    Map<String, dynamic>? data,
    Object? error,
    StackTrace? stackTrace,
  }) {
    _log(
      LogLevel.error,
      message,
      category: category,
      data: data,
      error: error,
      stackTrace: stackTrace,
    );
  }

  /// Log encryption operation start.
  static void cryptoStart(String operation, {Map<String, dynamic>? data}) {
    debug('$operation started', category: LogCategory.crypto, data: data);
  }

  /// Log encryption operation success.
  static void cryptoSuccess(String operation, {Map<String, dynamic>? data}) {
    debug('$operation completed', category: LogCategory.crypto, data: data);
  }

  /// Log encryption operation failure.
  static void cryptoError(
    String operation,
    Object error, {
    StackTrace? stackTrace,
    Map<String, dynamic>? data,
  }) {
    Logger.error(
      '$operation failed',
      category: LogCategory.crypto,
      error: error,
      stackTrace: stackTrace,
      data: data,
    );
  }

  /// Log FFI call.
  static void ffiCall(String method, {Map<String, dynamic>? args}) {
    debug(
      'FFI call: $method',
      category: LogCategory.ffi,
      data: args != null ? {'args': _sanitizeArgs(args)} : null,
    );
  }

  /// Log FFI result.
  static void ffiResult(String method, {bool success = true, Object? error}) {
    if (success) {
      debug('FFI result: $method succeeded', category: LogCategory.ffi);
    } else {
      Logger.error(
        'FFI result: $method failed',
        category: LogCategory.ffi,
        error: error,
      );
    }
  }

  /// Log session event.
  static void sessionEvent(
    String event, {
    String? sessionId,
    Map<String, dynamic>? data,
  }) {
    info(
      event,
      category: LogCategory.session,
      data: {
        if (sessionId != null) 'sessionId': _truncate(sessionId),
        ...?data,
      },
    );
  }

  /// Log message event.
  static void messageEvent(
    String event, {
    String? messageId,
    String? sessionId,
    Map<String, dynamic>? data,
  }) {
    debug(
      event,
      category: LogCategory.message,
      data: {
        if (messageId != null) 'messageId': _truncate(messageId),
        if (sessionId != null) 'sessionId': _truncate(sessionId),
        ...?data,
      },
    );
  }

  /// Internal log method.
  static void _log(
    LogLevel level,
    String message, {
    LogCategory category = LogCategory.app,
    Map<String, dynamic>? data,
    Object? error,
    StackTrace? stackTrace,
  }) {
    if (!enabled) return;
    if (level.index < minLevel.index) return;
    if (categoryFilter != null && !categoryFilter!.contains(category)) return;

    final timestamp = DateTime.now().toIso8601String();
    final levelStr = level.name.toUpperCase().padRight(7);
    final categoryStr = '[${category.name}]'.padRight(10);

    var output = '$timestamp $levelStr $categoryStr $message';

    if (data != null && data.isNotEmpty) {
      output += ' | ${_formatData(data)}';
    }

    if (error != null) {
      output += ' | Error: $error';
    }

    // Use developer.log for better DevTools integration
    developer.log(
      output,
      name: 'IrisChat',
      level: _levelToInt(level),
      error: error,
      stackTrace: stackTrace,
    );

    // Also print to console in debug mode.
    // Only mirror warning/error by default to avoid `debugPrint` buffering
    // massive log volumes in-memory under load.
    if (printToConsole && level.index >= LogLevel.warning.index) {
      debugPrint(output);
      if (stackTrace != null) {
        debugPrint(stackTrace.toString());
      }
    }
  }

  /// Convert log level to int for developer.log.
  static int _levelToInt(LogLevel level) {
    switch (level) {
      case LogLevel.debug:
        return 500;
      case LogLevel.info:
        return 800;
      case LogLevel.warning:
        return 900;
      case LogLevel.error:
        return 1000;
    }
  }

  /// Format data map for logging.
  static String _formatData(Map<String, dynamic> data) {
    return data.entries.map((e) => '${e.key}=${e.value}').join(', ');
  }

  /// Truncate long strings for logging.
  static String _truncate(String value, {int maxLength = 16}) {
    if (value.length <= maxLength) return value;
    return '${value.substring(0, 8)}...${value.substring(value.length - 4)}';
  }

  /// Sanitize arguments to avoid logging sensitive data.
  static Map<String, dynamic> _sanitizeArgs(Map<String, dynamic> args) {
    final sanitized = <String, dynamic>{};
    for (final entry in args.entries) {
      if (_isSensitiveKey(entry.key)) {
        sanitized[entry.key] = '[REDACTED]';
      } else if (entry.value is String && (entry.value as String).length > 32) {
        sanitized[entry.key] = _truncate(entry.value as String);
      } else {
        sanitized[entry.key] = entry.value;
      }
    }
    return sanitized;
  }

  /// Check if a key name indicates sensitive data.
  static bool _isSensitiveKey(String key) {
    final lower = key.toLowerCase();
    return lower.contains('privkey') ||
        lower.contains('private') ||
        lower.contains('secret') ||
        lower.contains('password') ||
        lower.contains('token');
  }
}

import 'dart:async';
import 'dart:io';

import '../ffi/models/ndr_exception.dart';
import 'logger_service.dart';
import 'nostr_service.dart';

/// User-friendly error types for the app.
enum AppErrorType {
  /// Network connectivity issues
  network,

  /// Server/relay unavailable
  serverUnavailable,

  /// Authentication or key errors
  authentication,

  /// Encryption/decryption failures
  encryption,

  /// Storage/database errors
  storage,

  /// Invalid input or data format
  validation,

  /// Session expired or invalid
  sessionExpired,

  /// Rate limiting
  rateLimited,

  /// Permission denied
  permissionDenied,

  /// Unknown or unexpected errors
  unknown,
}

/// Represents an application error with user-friendly messaging.
class AppError implements Exception {
  const AppError({
    required this.type,
    required this.message,
    this.technicalDetails,
    this.originalError,
    this.stackTrace,
    this.isRetryable = false,
  });

  /// Create from any exception with automatic type detection.
  factory AppError.from(Object error, [StackTrace? stackTrace]) {
    return ErrorService.mapError(error, stackTrace);
  }

  final AppErrorType type;
  final String message;
  final String? technicalDetails;
  final Object? originalError;
  final StackTrace? stackTrace;
  final bool isRetryable;

  @override
  String toString() => message;

  /// Get a detailed string for debugging.
  String toDebugString() {
    final buffer = StringBuffer()
      ..writeln('AppError(${type.name}): $message');
    if (technicalDetails != null) {
      buffer.writeln('Details: $technicalDetails');
    }
    if (originalError != null) {
      buffer.writeln('Original: $originalError');
    }
    return buffer.toString();
  }
}

/// Service for error handling, mapping, and retry logic.
class ErrorService {
  /// Map any error to a user-friendly AppError.
  static AppError mapError(Object error, [StackTrace? stackTrace]) {
    // Log the original error
    Logger.error(
      'Error occurred',
      category: LogCategory.app,
      error: error,
      stackTrace: stackTrace,
    );

    // NdrException (FFI/crypto errors)
    if (error is NdrException) {
      return _mapNdrException(error, stackTrace);
    }

    // PlatformException (native code errors)
    if (error is PlatformException) {
      return _mapPlatformException(error, stackTrace);
    }

    // NostrException (relay errors)
    if (error is NostrException) {
      return AppError(
        type: AppErrorType.serverUnavailable,
        message: 'Unable to connect to messaging servers. Please check your connection.',
        technicalDetails: error.message,
        originalError: error,
        stackTrace: stackTrace,
        isRetryable: true,
      );
    }

    // Network errors
    if (error is SocketException) {
      return AppError(
        type: AppErrorType.network,
        message: 'No internet connection. Please check your network settings.',
        technicalDetails: error.message,
        originalError: error,
        stackTrace: stackTrace,
        isRetryable: true,
      );
    }

    // Timeout errors
    if (error is TimeoutException) {
      return AppError(
        type: AppErrorType.network,
        message: 'The operation timed out. Please try again.',
        technicalDetails: error.message,
        originalError: error,
        stackTrace: stackTrace,
        isRetryable: true,
      );
    }

    // State errors
    if (error is StateError) {
      return AppError(
        type: AppErrorType.unknown,
        message: 'An unexpected error occurred. Please restart the app.',
        technicalDetails: error.message,
        originalError: error,
        stackTrace: stackTrace,
        isRetryable: false,
      );
    }

    // Format errors
    if (error is FormatException) {
      return AppError(
        type: AppErrorType.validation,
        message: 'Invalid data format. The data may be corrupted.',
        technicalDetails: error.message,
        originalError: error,
        stackTrace: stackTrace,
        isRetryable: false,
      );
    }

    // Default unknown error
    return AppError(
      type: AppErrorType.unknown,
      message: 'Something went wrong. Please try again.',
      technicalDetails: error.toString(),
      originalError: error,
      stackTrace: stackTrace,
      isRetryable: true,
    );
  }

  static AppError _mapNdrException(NdrException error, StackTrace? stackTrace) {
    switch (error.type) {
      case NdrErrorType.invalidKey:
        return AppError(
          type: AppErrorType.authentication,
          message: 'Invalid cryptographic key. Please check your identity.',
          technicalDetails: error.message,
          originalError: error,
          stackTrace: stackTrace,
          isRetryable: false,
        );
      case NdrErrorType.invalidEvent:
        return AppError(
          type: AppErrorType.validation,
          message: 'Received an invalid message. It may be corrupted.',
          technicalDetails: error.message,
          originalError: error,
          stackTrace: stackTrace,
          isRetryable: false,
        );
      case NdrErrorType.cryptoFailure:
        return AppError(
          type: AppErrorType.encryption,
          message: 'Failed to encrypt or decrypt message. The session may need to be re-established.',
          technicalDetails: error.message,
          originalError: error,
          stackTrace: stackTrace,
          isRetryable: false,
        );
      case NdrErrorType.stateMismatch:
        return AppError(
          type: AppErrorType.sessionExpired,
          message: 'Session is out of sync. Please restart the conversation.',
          technicalDetails: error.message,
          originalError: error,
          stackTrace: stackTrace,
          isRetryable: false,
        );
      case NdrErrorType.serialization:
        return AppError(
          type: AppErrorType.storage,
          message: 'Failed to save or load session data.',
          technicalDetails: error.message,
          originalError: error,
          stackTrace: stackTrace,
          isRetryable: true,
        );
      case NdrErrorType.inviteError:
        return AppError(
          type: AppErrorType.validation,
          message: 'Invalid invite. It may be expired or already used.',
          technicalDetails: error.message,
          originalError: error,
          stackTrace: stackTrace,
          isRetryable: false,
        );
      case NdrErrorType.sessionNotReady:
        return AppError(
          type: AppErrorType.sessionExpired,
          message: 'Session is not ready. Please wait for the connection to establish.',
          technicalDetails: error.message,
          originalError: error,
          stackTrace: stackTrace,
          isRetryable: true,
        );
      case NdrErrorType.unknown:
        return AppError(
          type: AppErrorType.unknown,
          message: 'An encryption error occurred. Please try again.',
          technicalDetails: error.message,
          originalError: error,
          stackTrace: stackTrace,
          isRetryable: true,
        );
    }
  }

  static AppError _mapPlatformException(
    PlatformException error,
    StackTrace? stackTrace,
  ) {
    // Check for common platform error codes
    switch (error.code) {
      case 'NETWORK_ERROR':
      case 'NetworkError':
        return AppError(
          type: AppErrorType.network,
          message: 'Network error. Please check your connection.',
          technicalDetails: error.message,
          originalError: error,
          stackTrace: stackTrace,
          isRetryable: true,
        );
      case 'PERMISSION_DENIED':
      case 'PermissionDenied':
        return AppError(
          type: AppErrorType.permissionDenied,
          message: 'Permission denied. Please grant the required permissions.',
          technicalDetails: error.message,
          originalError: error,
          stackTrace: stackTrace,
          isRetryable: false,
        );
      default:
        return AppError(
          type: AppErrorType.unknown,
          message: 'A platform error occurred. Please try again.',
          technicalDetails: '${error.code}: ${error.message}',
          originalError: error,
          stackTrace: stackTrace,
          isRetryable: true,
        );
    }
  }

  /// Execute an operation with automatic retry logic.
  static Future<T> withRetry<T>({
    required Future<T> Function() operation,
    int maxAttempts = 3,
    Duration initialDelay = const Duration(seconds: 1),
    double backoffMultiplier = 2.0,
    bool Function(Object error)? shouldRetry,
  }) async {
    var attempt = 0;
    var delay = initialDelay;

    while (true) {
      attempt++;
      try {
        return await operation();
      } catch (e, st) {
        final appError = mapError(e, st);

        // Check if we should retry
        final canRetry = shouldRetry?.call(e) ?? appError.isRetryable;
        if (!canRetry || attempt >= maxAttempts) {
          throw appError;
        }

        Logger.warning(
          'Operation failed, retrying',
          category: LogCategory.app,
          data: {
            'attempt': attempt,
            'maxAttempts': maxAttempts,
            'delayMs': delay.inMilliseconds,
          },
          error: e,
        );

        await Future.delayed(delay);
        delay = Duration(
          milliseconds: (delay.inMilliseconds * backoffMultiplier).round(),
        );
      }
    }
  }

  /// Execute an operation and return null on failure instead of throwing.
  static Future<T?> tryOperation<T>(
    Future<T> Function() operation, {
    void Function(AppError error)? onError,
  }) async {
    try {
      return await operation();
    } catch (e, st) {
      final appError = mapError(e, st);
      onError?.call(appError);
      return null;
    }
  }

  /// Get a short user-friendly message for an error type.
  static String getShortMessage(AppErrorType type) {
    switch (type) {
      case AppErrorType.network:
        return 'No connection';
      case AppErrorType.serverUnavailable:
        return 'Server unavailable';
      case AppErrorType.authentication:
        return 'Authentication error';
      case AppErrorType.encryption:
        return 'Encryption failed';
      case AppErrorType.storage:
        return 'Storage error';
      case AppErrorType.validation:
        return 'Invalid data';
      case AppErrorType.sessionExpired:
        return 'Session expired';
      case AppErrorType.rateLimited:
        return 'Too many requests';
      case AppErrorType.permissionDenied:
        return 'Permission denied';
      case AppErrorType.unknown:
        return 'Error occurred';
    }
  }
}

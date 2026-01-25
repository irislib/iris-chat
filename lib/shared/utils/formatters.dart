/// Utility functions for formatting display values.
///
/// These functions are used throughout the app to ensure consistent
/// formatting of pubkeys, dates, and times.
library;

/// Format a public key hex string for display.
///
/// Shows the first 6 characters, ellipsis, and last 6 characters.
/// If the string is 12 chars or shorter, returns it unchanged.
String formatPubkeyForDisplay(String hex) {
  if (hex.length <= 12) return hex;
  return '${hex.substring(0, 6)}...${hex.substring(hex.length - 6)}';
}

/// Format a DateTime for display as date.
///
/// Returns format: DD/MM/YYYY HH:MM
String formatDate(DateTime date) {
  return '${date.day}/${date.month}/${date.year} ${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')}';
}

/// Format a DateTime for display as time only.
///
/// Returns format: HH:MM
String formatTime(DateTime time) {
  return '${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}';
}

/// Format a DateTime for display as a relative or short date.
///
/// - Today: shows time as HH:MM
/// - Yesterday: shows "Yesterday"
/// - Within last week: shows day name (Mon, Tue, etc.)
/// - Older: shows DD/MM format
String formatRelativeDateTime(DateTime time) {
  final now = DateTime.now();
  final diff = now.difference(time);

  if (diff.inDays == 0) {
    return formatTime(time);
  } else if (diff.inDays == 1) {
    return 'Yesterday';
  } else if (diff.inDays < 7) {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    return days[time.weekday - 1];
  } else {
    return '${time.day}/${time.month}';
  }
}

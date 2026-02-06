import '../models/message.dart';

int _statusRank(MessageStatus s) {
  switch (s) {
    case MessageStatus.pending:
      return 0;
    case MessageStatus.queued:
      return 0;
    case MessageStatus.sent:
      return 1;
    case MessageStatus.delivered:
      return 2;
    case MessageStatus.seen:
      return 3;
    case MessageStatus.failed:
      return -1;
  }
}

/// Returns true if transitioning from [current] to [next] is a forward progress.
///
/// Used for remote delivery/read receipts to prevent status regression.
bool shouldAdvanceStatus(MessageStatus? current, MessageStatus next) {
  if (current == null) return true;
  if (current == next) return false;
  return _statusRank(next) > _statusRank(current);
}


export function shouldShowInviteResponseNotification(args: {
  anyVisibleClient: boolean
}): boolean {
  // If the app is already on-screen, the UI can show the update and we avoid
  // system-level notifications.
  return !args.anyVisibleClient
}

export function shouldShowSystemNotificationForMessagePush(args: {
  anyVisibleClient: boolean
  silentEvent: boolean
}): boolean {
  // Brave/Chromium can still surface "silent" placeholder notifications, so we
  // suppress them entirely:
  // - when any iris-chat window is visible
  // - for non-user-facing inner events (typing/receipts/etc.)
  if (args.anyVisibleClient) return false
  if (args.silentEvent) return false
  return true
}


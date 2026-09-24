export function getNotificationSupportError(): string | null {
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true

  if (isIOS && !isStandalone) {
    return 'To get notifications, choose Share → Add to Home Screen, then open Iris from your Home Screen.'
  }
  if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) {
    return 'This browser does not support push notifications.'
  }
  return null
}

export async function requestNotificationPermission(): Promise<{
  permission: NotificationPermission
  error?: string
}> {
  const supportError = getNotificationSupportError()
  if (supportError) return { permission: 'default', error: supportError }

  try {
    // Keep the native request before any other await so Safari sees the tap.
    const permission = Notification.permission === 'default'
      ? await Notification.requestPermission()
      : Notification.permission
    if (permission === 'denied') {
      return { permission, error: 'Notifications are blocked. Enable them in your browser or device notification settings.' }
    }
    if (permission !== 'granted') {
      return { permission, error: 'Notifications were not allowed. Please try again.' }
    }
    return { permission }
  } catch {
    return { permission: Notification.permission, error: 'Could not request notification permission. Please try again.' }
  }
}

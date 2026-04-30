export function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return

  const UPDATE_INTERVAL_MS = 10 * 60 * 1000

  // Check for updates periodically
  navigator.serviceWorker.ready.then((registration) => {
    console.log('[sw] ready')
    setInterval(() => {
      registration.update().catch(() => {})
    }, UPDATE_INTERVAL_MS)
  })
}

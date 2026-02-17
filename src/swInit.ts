export function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return

  const UPDATE_INTERVAL_MS = 10 * 60 * 1000

  // Prevent infinite reload loops
  const reloadKey = 'sw-reload'
  if (sessionStorage.getItem(reloadKey)) {
    sessionStorage.removeItem(reloadKey)
    return
  }

  // Auto-reload when new SW takes control
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    sessionStorage.setItem(reloadKey, '1')
    window.location.reload()
  })

  // Check for updates periodically
  navigator.serviceWorker.ready.then((registration) => {
    console.log('[sw] ready')
    setInterval(() => {
      registration.update().catch(() => {})
    }, UPDATE_INTERVAL_MS)
  })
}

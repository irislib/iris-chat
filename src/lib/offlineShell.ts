/** Cache the built shell without replacing the worker controlling an active conversation. */
export function installOfflineShell(worker: ServiceWorkerGlobalScope, manifest: Array<{ url: string; revision?: string | null }>) {
  const scope = worker.registration.scope
  const urls = new Set(manifest.map(entry => new URL(entry.url, scope).href))
  const fingerprint = [...JSON.stringify(manifest)].reduce((hash, char) => Math.imul(hash, 31) + char.charCodeAt(0) | 0, 0)
  const name = `iris-chat-shell-${fingerprint}`
  worker.addEventListener('install', event => {
    event.waitUntil(caches.open(name).then(cache => cache.addAll([...urls])))
  })
  worker.addEventListener('activate', event => {
    event.waitUntil(caches.keys().then(names => Promise.all(names.filter(key => key.startsWith('iris-chat-shell-') && key !== name)
      .map(key => caches.delete(key)))))
  })
  worker.addEventListener('fetch', event => {
    const request = event.request
    if (request.method !== 'GET') return
    if (request.mode === 'navigate' && request.url.startsWith(scope)) {
      event.respondWith(fetch(request).catch(async () => {
        const response = await (await caches.open(name)).match(new URL('index.html', scope).href)
        if (!response) throw new Error('Offline app unavailable')
        return response
      }))
    } else if (urls.has(request.url)) {
      event.respondWith(caches.open(name).then(async cache => (await cache.match(request, { ignoreVary: true })) ?? fetch(request)))
    }
  })
}

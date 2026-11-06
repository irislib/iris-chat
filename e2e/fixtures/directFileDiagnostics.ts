import { createHash } from 'node:crypto'
import type { BrowserContext, Page } from '@playwright/test'

// Temporary, test-only observation at the shared engine's event boundary.
// The served asset hashes identify this diagnostic overlay; it is not a claim
// that the instrumented response is byte-identical to the release artifact.
const knownErrors = new Set([
  'Selected file changed', 'Invalid retained file prefix', 'Invalid file data frame',
  'Received more data than offered', 'Received file did not match the offer',
  'Received file was not saved completely', 'File transfer ended before all files arrived',
  'File resume did not match the offer', 'File offer is no longer available',
  'File connection stopped', 'File connection closed', 'File transfer timed out',
  'File connection closed before completion', 'Device authorization changed',
  'File offer is already in use', 'File offer expired', 'File storage closed.',
  'Could not save received files.', 'File work stopped',
])
function safeError(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (knownErrors.has(value)) return value
  if (/Cannot load blob:.*due to access control checks\./.test(value)) return 'Cannot load blob:<redacted> due to access control checks.'
  return `unclassified error (${value.length} characters; content omitted)`
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export async function installDirectFileDiagnostics(context: BrowserContext) {
  const events: unknown[] = []
  const assets: Array<{ originalSha256: string; diagnosticSha256: string }> = []
  const failures: string[] = []
  await context.exposeBinding('__irisDirectFileDiagnostic', (_source, event: { type?: string; error?: unknown }) => {
    if (events.length < 32 && ['failed', 'paused', 'completed'].includes(event.type ?? '')) {
      events.push({ atMs: Date.now(), type: event.type, error: safeError(event.error) })
    }
  })
  await context.route(/\/assets\/vendor-[\w-]+\.js(?:\?.*)?$/, async route => {
    const url = new URL(route.request().url())
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      failures.push('non-loopback diagnostic asset rejected')
      await route.abort()
      return
    }
    const response = await route.fetch({ timeout: 5000, maxRedirects: 0 })
    const original = await response.text()
    // Fail closed if the coherent successor changes this one engine boundary.
    const emitter = /function ([$\w]+)\(([$\w]+),([$\w]+)\)\{try\{\2\.options\.onEvent\(\3\)/g
    const matches = [...original.matchAll(emitter)]
    if (matches.length !== 1) {
      failures.push(`expected one direct-file event boundary, found ${matches.length}`)
      await route.abort()
      return
    }
    const match = matches[0], event = match[3]
    const observation = `try{if(["failed","paused","completed"].includes(${event}.type))globalThis.__irisDirectFileDiagnostic?.({type:${event}.type,error:${event}.error})?.catch(()=>{})}catch{}`
    const replacement = match[0].replace('try{', `try{${observation}`)
    const diagnostic = original.replace(match[0], replacement)
    assets.push({ originalSha256: digest(original), diagnosticSha256: digest(diagnostic) })
    await route.fulfill({ response, body: diagnostic })
  })
  return {
    async snapshot(page: Page | undefined) {
      let saved: unknown = { unavailable: 'page closed' }
      if (page && !page.isClosed()) {
        try {
          saved = await page.evaluate(async () => {
            const rows: unknown[] = []
            return await new Promise<unknown[]>(resolve => {
              let done = false
              const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(rows) } }
              const timer = setTimeout(finish, 2000)
              const request = indexedDB.open('iris-chat')
              request.onerror = finish
              request.onsuccess = () => {
                const db = request.result
                if (done) { db.close(); return }
                const tx = db.transaction('sessionManager', 'readonly')
                tx.oncomplete = () => { db.close(); finish() }
                tx.onerror = () => { db.close(); finish() }
                const cursor = tx.objectStore('sessionManager').openCursor()
                let scanned = 0
                cursor.onsuccess = () => {
                  const row = cursor.result
                  if (!row || ++scanned > 256 || rows.length >= 32) return
                  const key = String(row.key), value = row.value.value
                  if (/^v1\/direct-files\//.test(key)) rows.push({ type: 'transfer', status: value?.status,
                    isSender: value?.isSender, transferredBytes: value?.transferredBytes,
                    totalBytes: value?.totalBytes, needsSource: value?.needsSource })
                  if (/^v2\/direct-files\/.*\/claims\/(send|receive)\//.test(key)) rows.push({
                    type: 'claim', side: key.includes('/claims/send/') ? 'send' : 'receive', status: value?.status,
                  })
                  if (/^v2\/direct-files\/.*\/sources\//.test(key) && Array.isArray(value)) rows.push({
                    type: 'sources', sizes: value.slice(0, 32).map(blob => blob instanceof Blob ? blob.size : null),
                  })
                  cursor.continue()
                }
              }
            })
          })
        } catch { saved = { unavailable: 'snapshot failed' } }
      }
      return { events, assets, failures, saved }
    },
  }
}

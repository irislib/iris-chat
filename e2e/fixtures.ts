/**
 * Playwright fixtures: one test relay per test + auto-configured pages.
 *
 * - testRelay: one relay per test, shared by its browser contexts
 * - testRelayUrl: relay URL for manual context creation
 * - page: overridden to configure relay via context init script
 *
 * This ensures ALL tests (including { page } tests) use the local relay.
 */

import { test as base, type BrowserContext, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { verifyEvent } from 'nostr-tools'
import { SilentTestRelay, TestRelay } from './test-relay'

const inviteBlobs = new Map<string, Map<string, Buffer>>()

/** Serve the same encrypted leaves to the native CLI in interoperability tests. */
export async function serveInviteBlobs(relayUrl: string): Promise<{ url: string; close: () => Promise<void> }> {
  let blobs = inviteBlobs.get(relayUrl)
  if (!blobs) { blobs = new Map(); inviteBlobs.set(relayUrl, blobs) }
  const sharedBlobs = blobs
  const server = createServer(async (request, response) => {
    const name = (request.url || '').slice(1).replace(/\.bin$/, '')
    if (request.method === 'PUT' && name === 'upload') {
      try {
        const chunks: Buffer[] = []; let size = 0
        for await (const chunk of request) {
          size += chunk.length
          if (size > 4 * 1024 * 1024) { response.writeHead(413); response.end(); return }
          chunks.push(chunk)
        }
        const data = Buffer.concat(chunks), hash = createHash('sha256').update(data).digest('hex')
        const auth = request.headers.authorization
        if (!auth?.startsWith('Nostr ')) throw new Error('Missing authorization')
        const event = JSON.parse(Buffer.from(auth.slice(6), 'base64').toString())
        if (!verifyEvent(event) || event.kind !== 24242 ||
          !event.tags.some((tag: string[]) => tag[0] === 't' && tag[1] === 'upload') ||
          !event.tags.some((tag: string[]) => tag[0] === 'x' && tag[1] === hash) ||
          !event.tags.some((tag: string[]) => tag[0] === 'expiration' && Number(tag[1]) > Date.now() / 1000)) throw new Error('Invalid upload authorization')
        sharedBlobs.set(hash, data)
        response.writeHead(201, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ sha256: hash, size: data.length }))
      } catch { response.writeHead(401); response.end() }
      return
    }
    const data = sharedBlobs.get(name)
    response.writeHead(data ? 200 : 404, { 'content-type': 'application/octet-stream' })
    response.end(request.method === 'HEAD' ? undefined : data)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

/**
 * Configure a browser context to use the test relay. Most scenarios exercise
 * chat after the optional download suggestion was dismissed; its own suite
 * opts into the real first-visit prompt with showNativeAppSuggestion.
 */
export async function useTestRelay(context: BrowserContext, relayUrlOrUrls: string | string[],
  { showNativeAppSuggestion = false }: { showNativeAppSuggestion?: boolean } = {}) {
  const relayUrls = Array.isArray(relayUrlOrUrls) ? relayUrlOrUrls : [relayUrlOrUrls]

  let blobs = inviteBlobs.get(relayUrls[0])
  if (!blobs) { blobs = new Map(); inviteBlobs.set(relayUrls[0], blobs) }
  const sharedBlobs = blobs
  // WebKit's interception protocol omits Blob request bodies. Capture that same
  // encrypted upload at fetch's boundary instead, retaining real hash validation
  // and sharing the bytes with the ordinary read fixture across contexts.
  if (context.browser()?.browserType().name() === 'webkit') {
    await context.exposeBinding('__irisTestEncryptedUpload', (_source, bytes: number[]) => {
      const data = Buffer.from(bytes), hash = createHash('sha256').update(data).digest('hex')
      sharedBlobs.set(hash, data)
      return { sha256: hash, size: data.length, url: `https://cdn.iris.to/${hash}` }
    })
    await context.addInitScript(() => {
      const original = window.fetch.bind(window)
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
        if (url === 'https://upload.iris.to/upload' && method.toUpperCase() === 'PUT') {
          const body = await new Request(input, init).arrayBuffer()
          const capture = (window as unknown as { __irisTestEncryptedUpload: (bytes: number[]) => Promise<unknown> }).__irisTestEncryptedUpload
          return new Response(JSON.stringify(await capture(Array.from(new Uint8Array(body)))), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return original(input, init)
      }
    })
  }
  await context.route(/^https:\/\/(?:upload|cdn)\.iris\.to\/(?:upload|[a-f0-9]{64}(?:\.bin)?)$/, async route => {
    const request = route.request(), path = new URL(request.url()).pathname.slice(1).replace(/\.bin$/, '')
    if (request.method() === 'PUT' && path === 'upload') {
      const data = request.postDataBuffer()!
      const hash = createHash('sha256').update(data).digest('hex')
      sharedBlobs.set(hash, data)
      await route.fulfill({ status: 200, json: { sha256: hash, size: data.length, url: `https://cdn.iris.to/${hash}` } })
    } else if (request.method() === 'GET' && sharedBlobs.has(path)) {
      await route.fulfill({ status: 200, body: sharedBlobs.get(path)!, contentType: 'application/octet-stream' })
    } else await route.fulfill({ status: 404 })
  })

  await context.addInitScript(({ urls, showNativeAppSuggestion }) => {
    // Some initial documents (e.g. about:blank) have an opaque origin where
    // accessing localStorage throws a SecurityError. Ignore those and rely on
    // the init script running again for the real app origin.
    try {
      window.localStorage.setItem('iris-chat-relays', JSON.stringify(urls))
      if (!showNativeAppSuggestion) window.localStorage.setItem('iris-native-app-suggestion', 'dismissed')
    } catch {
      // ignore
    }
  }, { urls: relayUrls, showNativeAppSuggestion })
}

export const test = base.extend<
  { testRelayUrl: string; silentRelayUrl: string; testRelayUrls: string[]; showNativeAppSuggestion: boolean;
    testRelay: TestRelay; silentRelay: SilentTestRelay }
>({
  showNativeAppSuggestion: [false, { option: true }],
  // Fresh history and hooks prevent unrelated prior tests from delaying admission.
  testRelay: [async ({}, use) => {
    const relay = new TestRelay()
    relay.debug = process.env.TEST_RELAY_DEBUG === '1'
    await relay.start()
    await use(relay)
    inviteBlobs.delete(relay.url)
    await relay.stop()
  }, { scope: 'test' }],

  silentRelay: [async ({}, use) => {
    const relay = new SilentTestRelay()
    await relay.start()
    await use(relay)
    await relay.stop()
  }, { scope: 'test' }],

  testRelayUrl: async ({ testRelay }, use) => {
    await use(testRelay.url)
  },

  silentRelayUrl: async ({ silentRelay }, use) => {
    await use(silentRelay.url)
  },

  testRelayUrls: async ({ testRelay, silentRelay }, use) => {
    await use([testRelay.url, silentRelay.url])
  },

  // Override page: configure relay on the page's context before use
  page: async ({ page, testRelay, showNativeAppSuggestion }, use) => {
    await useTestRelay(page.context(), testRelay.url, { showNativeAppSuggestion })
    await use(page)
  },
})

export { expect } from '@playwright/test'

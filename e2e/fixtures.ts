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
import { SilentTestRelay, TestRelay } from './test-relay'

const inviteBlobs = new Map<string, Map<string, Buffer>>()

/** Serve the same encrypted leaves to the native CLI in interoperability tests. */
export async function serveInviteBlobs(relayUrl: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const data = inviteBlobs.get(relayUrl)?.get((request.url || '').slice(1))
    response.writeHead(data ? 200 : 404, { 'content-type': 'application/octet-stream' })
    response.end(data)
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
  await context.route(/^https:\/\/(?:upload|cdn)\.iris\.to\/(?:upload|[a-f0-9]{64})$/, async route => {
    const request = route.request(), path = new URL(request.url()).pathname.slice(1)
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

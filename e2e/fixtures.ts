/**
 * Playwright fixtures: one test relay per worker + auto-configured pages.
 *
 * - testRelay: one relay per worker (isolated, no cross-talk between tests)
 * - testRelayUrl: relay URL for manual context creation
 * - page: overridden to configure relay via context init script
 *
 * This ensures ALL tests (including { page } tests) use the local relay.
 */

import { test as base, type BrowserContext, type Page } from '@playwright/test'
import { SilentTestRelay, TestRelay } from './test-relay'

/**
 * Configure a browser context to use the test relay.
 */
export async function useTestRelay(context: BrowserContext, relayUrlOrUrls: string | string[]) {
  const relayUrls = Array.isArray(relayUrlOrUrls) ? relayUrlOrUrls : [relayUrlOrUrls]

  await context.addInitScript((urls: string[]) => {
    // Some initial documents (e.g. about:blank) have an opaque origin where
    // accessing localStorage throws a SecurityError. Ignore those and rely on
    // the init script running again for the real app origin.
    try {
      window.localStorage.setItem('iris-chat-relays', JSON.stringify(urls))
    } catch {
      // ignore
    }
  }, relayUrls)
}

export const test = base.extend<
  { testRelayUrl: string; silentRelayUrl: string; testRelayUrls: string[] },
  { testRelay: TestRelay; silentRelay: SilentTestRelay }
>({
  // One relay per worker (isolated)
  testRelay: [async ({}, use) => {
    const relay = new TestRelay()
    relay.debug = process.env.TEST_RELAY_DEBUG === '1'
    await relay.start()
    await use(relay)
    await relay.stop()
  }, { scope: 'worker' }],

  silentRelay: [async ({}, use) => {
    const relay = new SilentTestRelay()
    await relay.start()
    await use(relay)
    await relay.stop()
  }, { scope: 'worker' }],

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
  page: async ({ page, testRelay }, use) => {
    await useTestRelay(page.context(), testRelay.url)
    await use(page)
  },
})

export { expect } from '@playwright/test'

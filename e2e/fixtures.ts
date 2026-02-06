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
import { TestRelay } from './test-relay'

/**
 * Configure a browser context to use the test relay.
 */
export async function useTestRelay(context: BrowserContext, relayUrl: string) {
  await context.addInitScript((url: string) => {
    // Some initial documents (e.g. about:blank) have an opaque origin where
    // accessing localStorage throws a SecurityError. Ignore those and rely on
    // the init script running again for the real app origin.
    try {
      window.localStorage.setItem('iris-chat-relays', JSON.stringify([url]))
    } catch {
      // ignore
    }
  }, relayUrl)
}

export const test = base.extend<{ testRelayUrl: string }, { testRelay: TestRelay }>({
  // One relay per worker (isolated)
  testRelay: [async ({}, use) => {
    const relay = new TestRelay()
    relay.debug = process.env.TEST_RELAY_DEBUG === '1'
    await relay.start()
    await use(relay)
    await relay.stop()
  }, { scope: 'worker' }],

  testRelayUrl: async ({ testRelay }, use) => {
    await use(testRelay.url)
  },

  // Override page: configure relay on the page's context before use
  page: async ({ page, testRelay }, use) => {
    await useTestRelay(page.context(), testRelay.url)
    await use(page)
  },
})

export { expect } from '@playwright/test'

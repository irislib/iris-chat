/**
 * Playwright fixtures that provide a local test relay.
 * Each worker gets its own relay instance.
 */

import { test as base, type BrowserContext } from '@playwright/test'
import { TestRelay } from './test-relay'

// Extend Playwright's test with a shared relay fixture
export const test = base.extend<object, { testRelay: TestRelay }>({
  // One relay per worker (shared across tests in the same worker)
  testRelay: [async ({}, use) => {
    const relay = new TestRelay()
    await relay.start()
    await use(relay)
    await relay.stop()
  }, { scope: 'worker' }],
})

/**
 * Helper: configure a browser context to use the test relay.
 * Call this before navigating to the app.
 */
export async function useTestRelay(context: BrowserContext, relayUrl: string) {
  await context.addInitScript((url: string) => {
    localStorage.setItem('iris-chat-relays', JSON.stringify([url]))
  }, relayUrl)
}

export { expect } from '@playwright/test'

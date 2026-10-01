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
import { SilentTestRelay, TestRelay } from './test-relay'

/**
 * Configure a browser context to use the test relay. Most scenarios exercise
 * chat after the optional download suggestion was dismissed; its own suite
 * opts into the real first-visit prompt with showNativeAppSuggestion.
 */
export async function useTestRelay(context: BrowserContext, relayUrlOrUrls: string | string[],
  { showNativeAppSuggestion = false }: { showNativeAppSuggestion?: boolean } = {}) {
  const relayUrls = Array.isArray(relayUrlOrUrls) ? relayUrlOrUrls : [relayUrlOrUrls]

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

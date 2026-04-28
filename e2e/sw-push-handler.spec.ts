/**
 * End-to-end coverage for the service worker `push` event handler.
 *
 * What this exercises:
 *   - Real double-ratchet session bootstrap via the invite flow.
 *   - Capture of the encrypted MESSAGE_EVENT_KIND (1060) envelope from
 *     the in-memory test relay after Alice publishes via the UI.
 *   - Synthetic dispatch of that envelope into Bob's service worker as
 *     a `push` event, with `self.registration.showNotification`
 *     monkey-patched to record calls.
 *   - Assertions on the rendered notification (body, tag, silent flag).
 *
 * To make the SW the *only* path that decrypts each envelope (rather
 * than racing Bob's main-app subscription, which would advance the
 * session state before the SW gets a turn), Bob's main app is reloaded
 * onto an unreachable relay after the session is established. Bob's
 * IndexedDB (sessions, identity, profiles) persists across the reload;
 * his subscriptions simply receive nothing.
 */

import { test, expect, useTestRelay } from './fixtures'
import type { Page, BrowserContext, Worker } from '@playwright/test'

const DEAD_RELAY_URL = 'ws://127.0.0.1:1'

async function loginAnonymously(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Go' }).click()
  await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible({ timeout: 30000 })
}

async function registerDevice(page: Page) {
  const settingsButton = page.getByRole('button', { name: 'Settings' })
  try {
    await settingsButton.waitFor({ state: 'visible', timeout: 5000 })
  } catch {
    return
  }
  await settingsButton.click()
  await page.getByRole('heading', { name: 'Devices' }).waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
  const registerButton = page.getByRole('button', { name: 'Register this device' })
  const thisDeviceLabel = page.getByText('This device').first()
  const deadline = Date.now() + 15_000
  let state: 'registered' | 'needs-registration' | 'loading' = 'loading'
  while (Date.now() < deadline) {
    if (await thisDeviceLabel.isVisible().catch(() => false)) { state = 'registered'; break }
    if (await registerButton.isVisible().catch(() => false)) { state = 'needs-registration'; break }
    await page.waitForTimeout(250)
  }
  if (state === 'loading') throw new Error('Timed out waiting for device registration state')
  if (state === 'needs-registration') {
    await registerButton.scrollIntoViewIfNeeded().catch(() => {})
    await registerButton.click({ timeout: 10000 })
    await expect.poll(async () => thisDeviceLabel.isVisible().catch(() => false), { timeout: 25000 }).toBe(true)
  }
  await page.getByRole('button', { name: 'Back' }).click()
}

async function getInviteUrl(page: Page): Promise<string> {
  await registerDevice(page)
  const copyButton = page.locator('button[title*="#"]').first()
  await expect(copyButton).toBeVisible()
  const url = await copyButton.getAttribute('title')
  if (!url) throw new Error('Could not get invite URL')
  return url.replace('https://chat.iris.to', 'http://localhost:4173')
}

async function setupUserWithInvite(page: Page): Promise<string> {
  await loginAnonymously(page)
  await registerDevice(page)
  await page.getByRole('button', { name: 'New Chat' }).click()
  return getInviteUrl(page)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function openChatFromList(page: Page, message: string): Promise<void> {
  const chatList = page.getByTestId('sidebar-chat-list')
  const listItemName = new RegExp(escapeRegExp(message))
  const allTab = page.getByTestId('sidebar-tab-all')
  const requestsTab = page.getByTestId('sidebar-tab-requests')
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    for (const tabButton of [allTab, requestsTab]) {
      await tabButton.click().catch(() => {})
      const item = chatList.getByRole('button', { name: listItemName }).first()
      const itemByText = chatList.locator('button').filter({ hasText: message }).first()
      for (const candidate of [item, itemByText]) {
        if (await candidate.isVisible().catch(() => false)) {
          await candidate.scrollIntoViewIfNeeded().catch(() => {})
          await candidate.click()
          return
        }
      }
    }
    await page.waitForTimeout(250)
  }
  throw new Error(`Could not find chat list item for message preview: ${message}`)
}

async function joinAndExchange(inviter: Page, joiner: Page, inviteUrl: string, message: string) {
  await joiner.getByPlaceholder('Paste invite link').fill(inviteUrl)
  await expect(joiner.getByPlaceholder('Type a message...')).toBeVisible()
  await joiner.getByPlaceholder('Type a message...').fill(message)
  await joiner.getByRole('button', { name: 'Send' }).click()
  // Inviter side: switch to Requests tab if necessary and open the chat.
  await openChatFromList(inviter, message)
  await expect(inviter.locator('.max-w-\\[85\\%\\]').filter({ hasText: message })).toBeVisible({ timeout: 30_000 })
}

async function getServiceWorker(context: BrowserContext): Promise<Worker> {
  const existing = context.serviceWorkers()
  if (existing.length > 0) return existing[0]
  return new Promise<Worker>((resolve) => {
    context.once('serviceworker', (sw) => resolve(sw))
  })
}

async function waitForServiceWorkerReady(page: Page) {
  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return
    await navigator.serviceWorker.ready
  })
}

// Patch `self.registration.showNotification` inside the SW to capture every
// call into a global array. Idempotent — subsequent calls reset the buffer.
async function instrumentSW(sw: Worker) {
  await sw.evaluate(() => {
    interface IrisInstrumentedGlobal {
      __irisCapturedNotifications: Array<{ title: string; options: NotificationOptions | undefined }>
      __irisInstrumented?: boolean
    }
    const g = self as unknown as IrisInstrumentedGlobal
    g.__irisCapturedNotifications = []
    if (g.__irisInstrumented) return
    g.__irisInstrumented = true
    const reg = self.registration
    const original = reg.showNotification.bind(reg)
    reg.showNotification = (title: string, options?: NotificationOptions) => {
      g.__irisCapturedNotifications.push({ title, options })
      // Don't actually surface the notification in test; permission is denied
      // by default in headless Chrome anyway, but skipping avoids any flake.
      return Promise.resolve()
        .then(() => undefined)
        .catch(() => original(title, options))
    }
  })
}

async function getCapturedNotifications(
  sw: Worker
): Promise<Array<{ title: string; options: NotificationOptions | undefined }>> {
  return await sw.evaluate(() => {
    const g = self as unknown as { __irisCapturedNotifications?: Array<{ title: string; options: NotificationOptions | undefined }> }
    const captured = g.__irisCapturedNotifications ?? []
    g.__irisCapturedNotifications = []
    return captured
  })
}

// Synthesize a `push` ExtendableEvent in the SW context with the provided
// payload, dispatch it to all registered listeners, and await every
// `waitUntil` promise so the handler's IndexedDB / decrypt work completes
// before we read the captured notifications.
async function dispatchPush(sw: Worker, payload: { event: unknown }) {
  await sw.evaluate(async (payload) => {
    const data = {
      json: () => payload,
      text: () => JSON.stringify(payload),
      arrayBuffer: () => new TextEncoder().encode(JSON.stringify(payload)).buffer,
    }
    const event = new ExtendableEvent('push') as ExtendableEvent & {
      data?: unknown
      waitUntil: (p: Promise<unknown>) => void
    }
    Object.defineProperty(event, 'data', { value: data, configurable: true })
    const promises: Promise<unknown>[] = []
    Object.defineProperty(event, 'waitUntil', {
      configurable: true,
      value: (p: Promise<unknown>) => { promises.push(p) },
    })
    self.dispatchEvent(event)
    await Promise.all(promises)
  }, payload)
}

async function configureRelays(context: BrowserContext, relays: string[]) {
  await context.addInitScript((urls: string[]) => {
    try {
      window.localStorage.setItem('iris-chat-relays', JSON.stringify(urls))
    } catch {
      /* ignore opaque origins */
    }
  }, relays)
}

test.describe('SW push handler', () => {
  test.setTimeout(180_000)

  test('decrypts inner rumors and shows kind-specific notifications', async ({ browser, testRelay, testRelayUrl }) => {
    const aliceContext = await browser.newContext()
    const bobContext = await browser.newContext()
    await useTestRelay(aliceContext, testRelayUrl)
    await useTestRelay(bobContext, testRelayUrl)

    const alice = await aliceContext.newPage()
    const bob = await bobContext.newPage()

    try {
      // 1. Establish a real ratchet session via the invite flow.
      const inviteUrl = await setupUserWithInvite(alice)

      await loginAnonymously(bob)
      await registerDevice(bob)
      await bob.getByRole('button', { name: 'New Chat' }).click()
      await joinAndExchange(alice, bob, inviteUrl, 'hi from bob')

      // Confirm Bob's IndexedDB has a session before we knock him offline.
      const bobSessionsBefore = await bob.evaluate(async () => {
        const open = indexedDB.open('iris-chat')
        return new Promise<number>((resolve, reject) => {
          open.onerror = () => reject(open.error)
          open.onsuccess = () => {
            const db = open.result
            const tx = db.transaction('sessions', 'readonly')
            const req = tx.objectStore('sessions').count()
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => reject(req.error)
          }
        })
      })
      expect(bobSessionsBefore, 'expected Bob to have at least one ratchet session in IndexedDB after invite').toBeGreaterThan(0)

      // 2. Re-point Bob to a dead relay and reload, so his main app cannot
      //    consume the events Alice is about to publish (which would
      //    advance ratchet state and starve the SW push handler).
      await configureRelays(bobContext, [DEAD_RELAY_URL])
      await bob.reload({ waitUntil: 'domcontentloaded' })
      await waitForServiceWorkerReady(bob)
      await expect(bob.getByRole('button', { name: 'New Chat' })).toBeVisible({ timeout: 30000 })

      const bobSW = await getServiceWorker(bobContext)
      await instrumentSW(bobSW)

      // Bob is on the chat list, not focused inside any specific chat.

      // 3. Alice sends a chat message → captured on the test relay.
      // Alice should already have the chat with Bob open from joinAndExchange.
      await expect(alice.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 10_000 })

      const messageBody = 'Hello Bob from Alice ' + Math.random().toString(36).slice(2, 8)
      const beforeCount = testRelay.publishedEvents.filter((e) => e.kind === 1060).length
      await alice.getByPlaceholder('Type a message...').fill(messageBody)
      await alice.getByRole('button', { name: 'Send' }).click()

      const chatEnvelope = await waitForNewKind1060(testRelay, beforeCount)

      // 4. Inject into Bob's SW.
      await dispatchPush(bobSW, { event: chatEnvelope })

      let captured = await getCapturedNotifications(bobSW)
      const msgNotif = captured.find((n) => n.options?.body === messageBody)
      expect(msgNotif, `expected chat-message notification with body "${messageBody}", got ${JSON.stringify(captured)}`).toBeTruthy()
      expect(msgNotif!.options!.tag).toMatch(/^dm-/)
      expect(msgNotif!.options!.tag).not.toMatch(/-status$/)
      expect(msgNotif!.options!.silent).toBeFalsy()

      // 5. Engagement gate: when Bob is focused on the source chat, the SW
      //    should skip the notification entirely.
      await bob.getByTestId('sidebar-chat-list').locator('button').filter({ hasText: messageBody }).first().click().catch(async () => {
        // Fall back: open whichever chat with Alice is in the list.
        await bob.getByTestId('sidebar-chat-list').locator('button').first().click()
      })
      await expect(bob.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 10000 })
      await waitForServiceWorkerReady(bob)
      // Allow Bob's app to inform the SW about the open chat (via GET_OPEN_CHAT message handshake).
      await bob.waitForTimeout(300)

      const messageBody2 = 'Second hello ' + Math.random().toString(36).slice(2, 8)
      const beforeCount2 = testRelay.publishedEvents.filter((e) => e.kind === 1060).length
      await alice.getByPlaceholder('Type a message...').fill(messageBody2)
      await alice.getByRole('button', { name: 'Send' }).click()
      const chatEnvelope2 = await waitForNewKind1060(testRelay, beforeCount2)

      await dispatchPush(bobSW, { event: chatEnvelope2 })

      captured = await getCapturedNotifications(bobSW)
      const msgNotif2 = captured.find((n) => n.options?.body === messageBody2)
      expect(msgNotif2, `expected NO notification when focused on source chat, got ${JSON.stringify(captured)}`).toBeUndefined()

      // 6. Typing indicator: Bob navigates back out of the chat, Alice keeps
      //    typing → produces a TYPING_KIND inner rumor wrapped in a kind-1060
      //    envelope. SW should render a silent ephemeral notification.
      await bob.getByRole('button', { name: 'Back' }).click()
      await expect(bob.getByRole('button', { name: 'New Chat' })).toBeVisible({ timeout: 10_000 })

      // The typing throttle is 3000 ms inside ChatView. Wait it out so the next
      // keystroke fires sendThrottledTyping immediately.
      await alice.getByPlaceholder('Type a message...').fill('').catch(() => {})
      await alice.waitForTimeout(3500)

      const beforeCount3 = testRelay.publishedEvents.filter((e) => e.kind === 1060).length
      // Type a single char (don't send) — fires sendTypingEvent (throttle: leading edge).
      await alice.getByPlaceholder('Type a message...').focus()
      await alice.keyboard.type('t')
      const typingEnvelope = await waitForNewKind1060(testRelay, beforeCount3, 10_000)

      await dispatchPush(bobSW, { event: typingEnvelope })

      captured = await getCapturedNotifications(bobSW)
      const typingNotif = captured.find((n) => n.options?.body === 'is typing…')
      expect(
        typingNotif,
        `expected silent typing notification, got ${JSON.stringify(captured)}`
      ).toBeTruthy()
      expect(typingNotif!.options!.tag).toMatch(/-status$/)
      expect(typingNotif!.options!.silent).toBe(true)

      // 7. Decryption-failure with a visible client: SW must skip
      //    showNotification (UA allows silent push when user is engaged) so
      //    the placeholder doesn't trip on every undecryptable envelope.
      const garbageEnvelope = {
        ...typingEnvelope,
        id: 'aa'.repeat(32),
        content: 'YmFkLWNvbnRlbnQtZm9yLXRlc3Rpbmc=',
      }
      await dispatchPush(bobSW, { event: garbageEnvelope })
      captured = await getCapturedNotifications(bobSW)
      expect(
        captured,
        `expected NO notification on decrypt-failure when client visible, got ${JSON.stringify(captured)}`
      ).toEqual([])

      // 8. Empty/missing event payload: SW always shows the generic
      //    "You have a new message" fallback so the browser doesn't
      //    surface its own background-update placeholder.
      await dispatchPush(bobSW, { event: undefined as unknown as object })
      captured = await getCapturedNotifications(bobSW)
      const fallback = captured.find((n) => n.options?.body === 'You have a new message')
      expect(
        fallback,
        `expected empty-payload fallback notification, got ${JSON.stringify(captured)}`
      ).toBeTruthy()
    } finally {
      // Clear input to avoid throttled typing leaking into other tests.
      await alice.getByPlaceholder('Type a message...').fill('').catch(() => {})
      await aliceContext.close()
      await bobContext.close()
    }
  })
})

async function waitForNewKind1060(
  testRelay: { publishedEvents: Array<{ kind: number; pubkey: string; id: string }> },
  beforeCount: number,
  timeoutMs = 15_000
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const events = testRelay.publishedEvents.filter((e) => e.kind === 1060)
    if (events.length > beforeCount) {
      return events[events.length - 1]
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out waiting for new kind-1060 envelope (had ${beforeCount}, still have ${
    testRelay.publishedEvents.filter((e) => e.kind === 1060).length
  })`)
}

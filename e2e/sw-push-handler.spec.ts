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

type ObservedNotification = {
  title: string
  body: string
  tag: string
  silent: boolean | null
}

// Read every active notification belonging to this SW registration. We rely
// on the real `showNotification` having fired (notification permission must
// be granted on the context). Browsers de-duplicate by `tag`, so the caller
// is responsible for closing notifications between scenarios.
async function readAllNotifications(sw: Worker): Promise<ObservedNotification[]> {
  return await sw.evaluate(async () => {
    const list = await self.registration.getNotifications()
    return list.map((n) => ({
      title: n.title,
      body: n.body,
      tag: n.tag,
      // Some Chromium versions expose silent via the Notification instance;
      // others return null even when the option was set. We tolerate both.
      silent: typeof n.silent === 'boolean' ? n.silent : null,
    }))
  })
}

async function clearAllNotifications(sw: Worker) {
  await sw.evaluate(async () => {
    const list = await self.registration.getNotifications()
    for (const n of list) n.close()
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

// Old chrome-headless-shell ignores Browser.grantPermissions for
// notifications, so showNotification silently no-ops and the e2e becomes
// useless. Force the full Chromium binary in new headless mode for this
// file — that's the same engine real users hit.
test.use({ channel: 'chromium' })

test.describe('SW push handler', () => {
  test.setTimeout(180_000)

  test('decrypts inner rumors and shows kind-specific notifications', async ({ browser, testRelay, testRelayUrl }) => {
    const aliceContext = await browser.newContext()
    const bobContext = await browser.newContext()
    await useTestRelay(aliceContext, testRelayUrl)
    await useTestRelay(bobContext, testRelayUrl)
    // Real notification permission so showNotification actually fires and
    // the resulting Notification instances appear in getNotifications().
    // Headless Chromium denies by default; without this, the SW silently
    // drops every showNotification call and we'd be testing nothing.
    await bobContext.grantPermissions(['notifications'], { origin: 'http://localhost:4173' })

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
      await clearAllNotifications(bobSW)

      // Confirm permission really is granted in the SW context — without it,
      // the browser silently drops every showNotification call and our
      // assertions would be meaningless.
      const permission = await bobSW.evaluate(() => self.Notification?.permission ?? 'unknown')
      expect(permission, 'notification permission must be granted for this test to be meaningful').toBe('granted')

      // Bob is on the chat list, not focused inside any specific chat.

      // 3. Alice sends a chat message. Bob's SW must decrypt the captured
      //    envelope and render a notification whose body is the *exact*
      //    plaintext Alice typed — proving end-to-end ratchet decryption
      //    in the real worker.
      await expect(alice.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 10_000 })

      const messageBody = 'Hello Bob from Alice ' + Math.random().toString(36).slice(2, 8)
      const beforeCount = testRelay.publishedEvents.filter((e) => e.kind === 1060).length
      await alice.getByPlaceholder('Type a message...').fill(messageBody)
      await alice.getByRole('button', { name: 'Send' }).click()

      const chatEnvelope = await waitForNewKind1060(testRelay, beforeCount)

      await dispatchPush(bobSW, { event: chatEnvelope })

      let notifications = await readAllNotifications(bobSW)
      // Decryption succeeded ⇒ the SW must have produced a notification
      // whose body exactly matches Alice's plaintext. Anything else
      // (fallback "New message", "You have a new message", missing notif)
      // would indicate decryption failure or routing bug.
      const msgNotif = notifications.find((n) => n.body === messageBody)
      expect(
        msgNotif,
        `expected DECRYPTED chat-message notification with body "${messageBody}", got ${JSON.stringify(notifications)}`
      ).toBeTruthy()
      expect(msgNotif!.tag).toMatch(/^dm-/)
      expect(msgNotif!.tag).not.toMatch(/-status$/)
      expect(msgNotif!.silent).not.toBe(true)

      // 4. Engagement gate: when Bob is focused on the source chat, the SW
      //    must skip showNotification entirely (silent push allowed by UA
      //    when user is engaged).
      await clearAllNotifications(bobSW)
      await bob.getByTestId('sidebar-chat-list').locator('button').filter({ hasText: messageBody }).first().click().catch(async () => {
        await bob.getByTestId('sidebar-chat-list').locator('button').first().click()
      })
      await expect(bob.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 10_000 })
      // Let Bob's app reply to GET_OPEN_CHAT.
      await bob.waitForTimeout(300)

      const messageBody2 = 'Second hello ' + Math.random().toString(36).slice(2, 8)
      const beforeCount2 = testRelay.publishedEvents.filter((e) => e.kind === 1060).length
      await alice.getByPlaceholder('Type a message...').fill(messageBody2)
      await alice.getByRole('button', { name: 'Send' }).click()
      const chatEnvelope2 = await waitForNewKind1060(testRelay, beforeCount2)

      await dispatchPush(bobSW, { event: chatEnvelope2 })

      notifications = await readAllNotifications(bobSW)
      expect(
        notifications,
        `expected NO notification when Bob focused on source chat, got ${JSON.stringify(notifications)}`
      ).toEqual([])

      // 5. Typing indicator: Bob navigates back to chat list, Alice keeps
      //    typing → TYPING_KIND inner rumor. SW must decrypt and render
      //    "is typing…" as silent ephemeral notification.
      await clearAllNotifications(bobSW)
      await bob.getByRole('button', { name: 'Back' }).click()
      await expect(bob.getByRole('button', { name: 'New Chat' })).toBeVisible({ timeout: 10_000 })

      // ChatView throttles typing to 3000 ms; clear the input and wait it out.
      await alice.getByPlaceholder('Type a message...').fill('').catch(() => {})
      await alice.waitForTimeout(3500)

      const beforeCount3 = testRelay.publishedEvents.filter((e) => e.kind === 1060).length
      await alice.getByPlaceholder('Type a message...').focus()
      await alice.keyboard.type('t')
      const typingEnvelope = await waitForNewKind1060(testRelay, beforeCount3, 10_000)

      await dispatchPush(bobSW, { event: typingEnvelope })

      notifications = await readAllNotifications(bobSW)
      const typingNotif = notifications.find((n) => n.body === 'is typing…')
      expect(
        typingNotif,
        `expected DECRYPTED typing notification "is typing…", got ${JSON.stringify(notifications)}`
      ).toBeTruthy()
      expect(typingNotif!.tag).toMatch(/-status$/)
      expect(typingNotif!.silent).toBe(true)

      // 6. Decryption-failure with a visible client: SW must skip
      //    showNotification (UA allows silent push when user is engaged) so
      //    the browser placeholder doesn't trip on every undecryptable
      //    envelope.
      await clearAllNotifications(bobSW)
      const garbageEnvelope = {
        ...typingEnvelope,
        id: 'aa'.repeat(32),
        content: 'YmFkLWNvbnRlbnQtZm9yLXRlc3Rpbmc=',
      }
      await dispatchPush(bobSW, { event: garbageEnvelope })
      notifications = await readAllNotifications(bobSW)
      expect(
        notifications,
        `expected NO notification on decrypt-failure when client visible, got ${JSON.stringify(notifications)}`
      ).toEqual([])

      // 7. Empty/missing event payload: SW must show the generic fallback
      //    so the browser doesn't surface its own background-update
      //    placeholder.
      await clearAllNotifications(bobSW)
      await dispatchPush(bobSW, { event: undefined as unknown as object })
      notifications = await readAllNotifications(bobSW)
      const fallback = notifications.find((n) => n.body === 'You have a new message')
      expect(
        fallback,
        `expected empty-payload fallback notification, got ${JSON.stringify(notifications)}`
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

import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { nip19 } from 'nostr-tools'
import { notificationHash } from '../src/lib/notificationNavigation'

async function login(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Go', exact: true }).click()
  await expect(page.getByRole('button', { name: 'New Chat', exact: true })).toBeVisible()
}
async function contact(page: Page, pubkey: string, draft: string) {
  if (!await page.getByRole('button', { name: 'New Chat', exact: true }).isVisible()) await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await page.getByPlaceholder('Paste invite link').fill(nip19.npubEncode(pubkey))
  await page.getByPlaceholder('Type a message...').fill(draft)
}
async function tap(page: Page, target: { chatId: string; ownerPubkey?: string }) {
  return page.evaluate(target => new Promise<boolean>(resolve => {
    const channel = new MessageChannel()
    channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data.received) }
    navigator.serviceWorker.dispatchEvent(new MessageEvent('message', {
      data: { type: 'NOTIFICATION_CLICK', target }, ports: [channel.port2],
    }))
  }), target)
}

test('notification taps select the exact chat warm and after startup, and reject another account', async ({ page }) => {
  await login(page)
  const first = 'c'.repeat(64), second = 'd'.repeat(64)
  await contact(page, first, 'First unsent draft')
  await contact(page, second, 'Second unsent draft')
  expect(await tap(page, { chatId: first })).toBe(true)
  await expect(page.getByPlaceholder('Type a message...')).toHaveValue('First unsent draft')
  await tap(page, { chatId: second, ownerPubkey: 'another-account' })
  await expect(page.getByPlaceholder('Type a message...')).toHaveValue('First unsent draft')
  await page.goto('/' + notificationHash({ chatId: second }))
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible()
  // A route resolves only after saved sessions load; verify the visible header
  // belongs to the requested contact, using the profile button's link target.
  await expect(page.locator('header button').filter({ has: page.locator('p.font-medium') })).toBeVisible()
  await page.locator('header button').filter({ has: page.locator('p.font-medium') }).click()
  await expect(page).toHaveURL(new RegExp(`#profile-${second}$`))
})

test('Log out is cancelable and clears this browser identity and chat data', async ({ page }) => {
  await login(page)
  await contact(page, 'c'.repeat(64), 'Private unsent draft')
  if (!await page.getByRole('button', { name: 'Settings', exact: true }).isVisible()) await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  page.once('dialog', async dialog => { expect(dialog.message()).toContain('other devices are not affected'); await dialog.dismiss() })
  await page.getByRole('button', { name: 'Log out', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Log out', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Go', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Go', exact: true })).toBeVisible()
  const remaining = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('iris-chat'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    const names = ['sessions', 'messages', 'groups', 'sessionManager', 'pendingPushEvents']
    const counts = await Promise.all(names.map(name => new Promise<number>((resolve, reject) => {
      const request = database.transaction(name).objectStore(name).count(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })))
    database.close(); return counts
  })
  expect(remaining).toEqual([0, 0, 0, 0, 0])
})

test('production service worker routes warm taps without reloading and emits a cold-start URL', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Playwright exposes worker evaluation only in Chromium')
  await login(page)
  const first = 'c'.repeat(64), second = 'd'.repeat(64)
  await contact(page, first, 'Keep this draft')
  await contact(page, second, 'Other draft')
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  const worker = context.serviceWorkers()[0]
  const documentStartedAt = await page.evaluate(() => performance.timeOrigin)
  const coldUrl = await worker.evaluate(async ({ first, second }) => {
    const scope = self as unknown as ServiceWorkerGlobalScope
    const originalMatch = scope.clients.matchAll.bind(scope.clients)
    const originalOpen = scope.clients.openWindow.bind(scope.clients)
    const windows = await originalMatch({ type: 'window', includeUncontrolled: true })
    let opened = ''
    async function click(chatId: string) {
      const pending: Promise<unknown>[] = []
      const event = new Event('notificationclick')
      Object.defineProperties(event, {
        notification: { value: { data: { chatId }, close() {} } },
        waitUntil: { value: (promise: Promise<unknown>) => pending.push(promise) },
      })
      scope.dispatchEvent(event)
      await Promise.all(pending)
    }
    try {
      // A synthetic click has no OS user activation. Only replace focus;
      // use the real WindowClient, MessagePort, app listener and routing.
      for (const client of windows) Object.defineProperty(client, 'focus', { value: async () => client })
      scope.clients.matchAll = (async () => windows) as typeof scope.clients.matchAll
      await click(first)
      scope.clients.matchAll = (async () => []) as typeof scope.clients.matchAll
      scope.clients.openWindow = async url => { opened = url; return null }
      await click(second)
      return opened
    } finally {
      scope.clients.matchAll = originalMatch
      scope.clients.openWindow = originalOpen
    }
  }, { first, second })
  await expect(page.getByPlaceholder('Type a message...')).toHaveValue('Keep this draft')
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStartedAt)
  expect(new URL(coldUrl).hash).toBe(notificationHash({ chatId: second }))
  await page.goto(coldUrl)
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible()
  await page.locator('header button').filter({ has: page.locator('p.font-medium') }).click()
  await expect(page).toHaveURL(new RegExp(`#profile-${second}$`))
})

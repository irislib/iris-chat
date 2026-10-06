import { test, expect, useTestRelay } from './fixtures'
import type { BrowserContext, Page } from '@playwright/test'
import { createDeviceLinkRequest, Invite } from 'nostr-double-ratchet'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'
import { createNostrRuntime } from 'nostr-pubsub'
import { startLocalFipsWebSocketSeed } from './fixtures/localFipsWebSocketSeed'
import { mkdir } from 'node:fs/promises'

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

test.describe.configure({ mode: 'serial' })

async function setIdentity(context: BrowserContext, privkeyHex: string) {
  await context.addInitScript((key: string) => {
    try {
      window.localStorage.setItem('iris-chat-identity', key)
    } catch {
      // Ignore opaque origins before the app document exists.
    }
  }, privkeyHex)
}

async function clearIdentity(context: BrowserContext) {
  await context.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('link-test-started')) { window.localStorage.removeItem('iris-chat-identity'); sessionStorage.setItem('link-test-started', '1') }
    } catch {
      // Ignore opaque origins before the app document exists.
    }
  })
}

async function loginWithStoredKey(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible({ timeout: 30_000 })
}

async function openLinkThisDevice(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Link this device' }).click()
  await expect(page.getByRole('heading', { name: 'Link this device' })).toBeVisible({
    timeout: 10_000,
  })

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const buttons = page.locator('button[title]')
    const count = await buttons.count()
    for (let index = 0; index < count; index += 1) {
      const url = await buttons.nth(index).getAttribute('title')
      if (url?.startsWith('nostrconnect://')) return url
    }
    await page.waitForTimeout(100)
  }
  throw new Error('Could not read device approval link')
}

for (const choice of ['Chats and groups only', 'Include message history']) test(`linking waits for ${choice} approval and persists the choice`, async ({
  browser,
  testRelayUrl,
  testRelay,
}) => {
  test.setTimeout(150_000)
  const seed = await startLocalFipsWebSocketSeed()
  const ownerContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const linkedContext = await browser.newContext()

  const relays = choice === 'Include message history' ? [testRelayUrl, 'ws://127.0.0.1:1'] : [testRelayUrl]
  await useTestRelay(ownerContext, relays)
  await useTestRelay(linkedContext, relays)
  for (const context of [ownerContext, linkedContext]) await context.addInitScript(url => localStorage.setItem('iris-chat-call-servers', JSON.stringify({ servers: [url], stunServers: [] })), seed.url)
  const secret = generateSecretKey(), account = getPublicKey(secret), contact = account
  await setIdentity(ownerContext, toHex(secret))
  await clearIdentity(linkedContext)
  await linkedContext.addInitScript(() => {
    const states: string[] = []
    Object.assign(window, { __historyProgressStates: states })
    document.addEventListener('DOMContentLoaded', () => new MutationObserver(() => {
      const text = document.querySelector('[data-testid="device-history-progress"]')?.textContent?.replace(/\s+/g, ' ').trim()
      if (text && states.at(-1) !== text && states.length < 32) states.push(text)
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true }))
  })

  const ownerPage = await ownerContext.newPage()
  const linkedPage = await linkedContext.newPage()

  try {
    await loginWithStoredKey(ownerPage)
    await ownerPage.getByRole('button', { name: 'Settings' }).click()
    await ownerPage.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Devices', exact: true }).click()
    const register = ownerPage.getByRole('button', { name: 'Register this device', exact: true })
    if (await register.isVisible()) await register.click()
    await expect(ownerPage.getByText('This device', { exact: true }).first()).toBeVisible()
    await ownerPage.evaluate(async ({ account, contact }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('iris-chat'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      const old = Date.now() - 3_600_000
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = database.transaction(['sessions', 'messages', 'groups'], 'readwrite')
          tx.objectStore('sessions').put({ id: contact, recipientPubkey: contact, createdAt: old, mode: 'manager' })
          tx.objectStore('messages').put({ id: 'initial-old-message', sessionId: contact, content: 'From before linking', timestamp: old, isMine: true, senderPubkey: account })
          tx.objectStore('groups').put({ id: 'initial-group', name: 'History group', members: [account], admins: [account], createdAt: old, accepted: true })
          tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
        })
      } finally { database.close() }
    }, { account, contact })
    await ownerPage.reload()
    await expect(ownerPage.getByText('History group', { exact: true })).toBeVisible()
    if (choice === 'Include message history') {
      // Existing native accounts could retain equal snapshots with fresh d/i UUIDs.
      const previous = testRelay.publishedEvents.filter(event => event.kind === 37368 && event.pubkey === account).sort((a, b) => b.created_at - a.created_at)[0]
      expect(previous).toBeDefined()
      const profile = crypto.randomUUID()
      const duplicate = finalizeEvent({ ...previous, tags: previous.tags.map(tag => tag[0] === 'd' || tag[0] === 'i' ? [tag[0], profile, ...tag.slice(2)] : tag) }, secret)
      const publisher = createNostrRuntime({ relays: [testRelayUrl] })
      try { expect((await publisher.publish(duplicate, { requireAck: true })).remoteAccepted).toBe(true) }
      finally { await publisher.close() }
    }
    const approvalUrl = await openLinkThisDevice(linkedPage)
    expect(approvalUrl).toMatch(/^nostrconnect:\/\//)
    const linkId = new URL(approvalUrl).hostname

    await ownerPage.getByRole('button', { name: 'Settings' }).click()
    await ownerPage.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Devices', exact: true }).click()
    await ownerPage.getByRole('button', { name: 'Link another device' }).click()
    await expect(ownerPage.getByRole('heading', { name: 'Link another device' })).toBeVisible()

    const priorClipboard = await ownerPage.evaluate(() => navigator.clipboard.readText())
    try {
      await ownerPage.evaluate(link => navigator.clipboard.writeText(link), approvalUrl)
      await ownerPage.getByPlaceholder('Paste link code').focus()
      await ownerPage.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')
      await expect(ownerPage.getByPlaceholder('Paste link code')).toHaveValue(approvalUrl)
    } finally { await ownerPage.evaluate(text => navigator.clipboard.writeText(text), priorClipboard) }
    await expect(ownerPage.getByRole('button', { name: choice, exact: true })).toBeVisible()
    await expect(linkedPage.getByRole('heading', { name: 'Link this device', exact: true })).toBeVisible()
    await mkdir('work/device-history', { recursive: true })
    await ownerPage.screenshot({ path: `work/device-history/approval-${choice.startsWith('Chats') ? 'chats' : 'history'}.png`, fullPage: true })
    await ownerPage.getByRole('button', { name: choice, exact: true }).click()

    await expect(ownerPage.getByRole('heading', { name: 'Link another device' })).toBeHidden({
      timeout: 100_000,
    })
    await expect(linkedPage.getByRole('button', { name: 'New Chat' })).toBeVisible({
      timeout: 10_000,
    })
    await expect(linkedPage.getByText('History group', { exact: true })).toBeVisible()
    const linkedMessageIds = () => linkedPage.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('iris-chat'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      try { return await new Promise<string[]>((resolve, reject) => {
        const request = database.transaction('messages').objectStore('messages').getAllKeys()
        request.onsuccess = () => resolve(request.result as string[]); request.onerror = () => reject(request.error)
      }) } finally { database.close() }
    })
    if (choice === 'Include message history') await expect.poll(linkedMessageIds).toContain('initial-old-message')
    else expect(await linkedMessageIds()).not.toContain('initial-old-message')
    await expect(linkedPage.getByTestId('device-history-progress')).toBeHidden()
    const progress = await linkedPage.evaluate(() => (window as unknown as { __historyProgressStates: string[] }).__historyProgressStates)
    if (choice === 'Include message history') {
      expect(progress.some(state => state.includes('Syncing messages…'))).toBe(true)
      // Partitioned reconciliation cannot know a total in advance. The stored
      // message assertion above verifies completion independently of UI timing.
    } else expect(progress).toEqual([])
    const readPairs = () => ownerPage.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('iris-chat'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      try {
        return await new Promise<Array<{ value: Array<{ peer: string; since: number; complete: boolean; linkId: string }> }>>((resolve, reject) => {
          const request = database.transaction('sessionManager').objectStore('sessionManager').getAll()
          request.onsuccess = () => resolve(request.result.filter((row: { key: string }) => row.key.startsWith('device-history-pairs:')))
          request.onerror = () => reject(request.error)
        })
      } finally { database.close() }
    })
    const policy = (await readPairs()).flatMap(row => row.value).find(pair => pair.linkId === linkId)
    expect(policy).toBeDefined()
    expect(policy.since).toEqual(choice === 'Include message history' ? 0 : expect.any(Number))
    if (choice === 'Chats and groups only') expect(policy.since).toBeGreaterThan(0)
    await ownerPage.reload()
    expect((await readPairs()).flatMap(row => row.value)).toContainEqual(policy)
    expect(testRelay.publishedEvents.some(event => event.kind === 30078 && event.tags.some(tag => tag[0] === 'd' && tag[1]?.startsWith('iris-chat-history-v1:')))).toBe(false)
    expect(JSON.stringify(testRelay.publishedEvents)).not.toContain('iris-chat-history')
    expect(JSON.stringify(testRelay.publishedEvents)).not.toContain('historyPolicy')
    await linkedPage.reload()
    await expect(linkedPage.getByRole('button', { name: 'New Chat' })).toBeVisible()
    await expect(linkedPage.getByText('History group', { exact: true })).toBeVisible()
    if (choice === 'Include message history') expect(await linkedMessageIds()).toContain('initial-old-message')
    else expect(await linkedMessageIds()).not.toContain('initial-old-message')
    await ownerPage.getByText('History group', { exact: true }).click()
    await ownerPage.getByPlaceholder('Type a message...').fill('New message after linking')
    await ownerPage.getByRole('button', { name: 'Send', exact: true }).click()
    await linkedPage.getByText('History group', { exact: true }).click()
    await expect(linkedPage.getByText('New message after linking', { exact: true }).last()).toBeVisible()
    if (choice === 'Chats and groups only') expect(await linkedMessageIds()).not.toContain('initial-old-message')
    await linkedPage.goto('about:blank')
    await ownerPage.getByPlaceholder('Type a message...').fill('Message while this device was away')
    await ownerPage.getByRole('button', { name: 'Send', exact: true }).click()
    await linkedPage.goto('/')
    await expect(linkedPage.getByRole('button', { name: 'New Chat' })).toBeVisible()
    await linkedPage.getByText('History group', { exact: true }).click()
    await expect(linkedPage.getByText('Message while this device was away', { exact: true }).last()).toBeVisible()
  } finally {
    await ownerContext.close()
    await linkedContext.close()
    await seed.close()
  }
})

for (const format of ['compact', 'url', 'hash', 'nostr'] as const) test(`pasted ${format} device link requires explicit approval`, async ({ browser, testRelay, testRelayUrl }) => {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  await useTestRelay(context, testRelayUrl)
  const secret = generateSecretKey(), owner = getPublicKey(secret)
  await setIdentity(context, toHex(secret))
  const page = await context.newPage()
  try {
    await loginWithStoredKey(page)
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Devices', exact: true }).click()
    const register = page.getByRole('button', { name: 'Register this device', exact: true })
    if (await register.isVisible()) await register.click()
    await expect(page.getByText('This device', { exact: true }).first()).toBeVisible()
    await page.getByRole('button', { name: 'Link another device' }).click()
    const request = createDeviceLinkRequest()
    const invite = Invite.createNew(request.request.deviceAppKeyPubkey, undefined, undefined, { purpose: 'link', ownerPubkey: owner })
    const url = invite.getUrl('https://chat.iris.to')
    const input = format === 'compact' ? request.code : format === 'url' ? url : format === 'hash' ? new URL(url).hash : `nostr:${url}`
    const prior = await page.evaluate(() => navigator.clipboard.readText())
    try {
      await page.evaluate(text => navigator.clipboard.writeText(text), input)
      await page.getByPlaceholder('Paste link code').focus()
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')
    } finally { await page.evaluate(text => navigator.clipboard.writeText(text), prior) }
    await expect(page.getByRole('button', { name: 'Chats and groups only', exact: true })).toBeVisible()
    expect(testRelay.publishedEvents.some(event => event.kind === 37368 && event.tags.some(tag => tag[0] === 'device' && tag[1] === request.request.deviceAppKeyPubkey))).toBe(false)
    await page.getByRole('button', { name: 'Chats and groups only', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Link another device' })).toBeHidden()
    expect(testRelay.publishedEvents.some(event => event.kind === 37368 && event.tags.some(tag => tag[0] === 'device' && tag[1] === request.request.deviceAppKeyPubkey))).toBe(true)
    await page.getByRole('button', { name: 'Link another device' }).click()
    await page.getByPlaceholder('Paste link code').fill('not a device link')
    await expect(page.getByRole('alert')).toContainText('Invalid device link')
    if (format === 'compact') {
      await page.getByPlaceholder('Paste link code').fill(createDeviceLinkRequest({ requestedAt: Math.floor(Date.now() / 1000) - 600 }).code)
      await page.getByRole('button', { name: 'Chats and groups only', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText('expired')
    }
  } finally { await context.close() }
})

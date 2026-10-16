import { test, expect, useTestRelay } from './fixtures'
import { startLocalFipsWebSocketSeed } from './fixtures/localFipsWebSocketSeed'
import type { Page } from '@playwright/test'

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64')
async function send(page: Page, text: string) {
  await page.getByPlaceholder('Type a message...').fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}
async function imageLoaded(page: Page, name: string) {
  await expect(page.getByAltText(name)).toBeVisible({ timeout: 25_000 })
  await expect.poll(() => page.getByAltText(name).evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1)
}
async function info(page: Page) {
  await page.getByRole('button', { name: 'Message menu', exact: true }).last().click()
  await page.getByRole('button', { name: 'Info', exact: true }).click()
  return page.getByRole('dialog', { name: 'Message info', exact: true })
}
test('accepted group peers exchange local ciphertext while HTTP storage is unavailable, and retain it after reload', async ({ browser, testRelayUrl }, testInfo) => {
  test.setTimeout(120_000)
  const seed = await startLocalFipsWebSocketSeed()
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()])
  const logs: string[] = []
  try {
    for (const context of contexts) {
      await useTestRelay(context, testRelayUrl)
      await context.addInitScript(url => {
        localStorage.setItem('iris-chat-call-servers', JSON.stringify({ servers: [url], stunServers: [] }))
        window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, { construct() { throw new Error('Use routed encrypted file transport') } })
      }, seed.url)
    }
    const [alice, bob, cara] = await Promise.all(contexts.map(context => context.newPage()))
    for (const [index, page] of [alice, bob, cara].entries()) {
      page.on('console', message => logs.push(`${index}: ${message.text()}`))
      page.on('pageerror', error => logs.push(`${index}: ${error.message}`))
    }
    await alice.goto('/'); await alice.getByLabel('Your name (optional)').fill('Alice')
    await alice.getByRole('button', { name: 'Go', exact: true }).click()
    const copy = alice.locator('button[title*="#/nhash"]').first(); await expect(copy).toBeVisible()
    const link = (await copy.getAttribute('title'))!.replace('https://chat.iris.to', new URL(alice.url()).origin)
    for (const [page, name] of [[bob, 'Bob'], [cara, 'Cara']] as const) {
      await page.goto(link); await page.getByLabel('Your name (optional)').fill(name)
      await page.getByRole('button', { name: 'Join Chat', exact: true }).click()
      await send(page, `Hello from ${name}`)
      await expect(alice.getByTestId('sidebar-chat-list').getByText(`Hello from ${name}`, { exact: true })).toBeVisible()
    }
    await alice.getByRole('button', { name: 'New Chat', exact: true }).click()
    await alice.getByRole('button', { name: 'Create Group', exact: true }).click()
    for (const name of ['Bob', 'Cara']) await alice.getByTestId('create-group-member').filter({ has: alice.getByText(name, { exact: true }) }).click()
    await alice.getByTestId('create-group-next').click()
    await alice.getByPlaceholder('Enter group name...').fill('Offline files')
    await alice.getByTestId('create-group-submit').click(); await send(alice, 'Group ready')
    for (const page of [bob, cara]) {
      await page.getByTestId('sidebar-chat-list').getByRole('button', { name: /Offline files/ }).click()
      await page.getByRole('button', { name: 'Accept', exact: true }).click()
      await send(page, page === bob ? 'Bob ready' : 'Cara ready')
    }
    await expect(bob.getByText('Cara ready', { exact: true }).last()).toBeVisible()
    await expect(cara.getByText('Bob ready', { exact: true }).last()).toBeVisible()
    await expect.poll(() => seed.connectedPeers().length).toBe(3)
    // Bob and Cara have no direct relationship. The administrator cannot seed for them.
    await alice.goto('about:blank')
    for (const context of contexts) await context.route(/^https:\/\/(?:upload|cdn)\.iris\.to\//, route => route.abort())
    await bob.locator('input[type=file]').first().setInputFiles({ name: 'offline.png', mimeType: 'image/png', buffer: image })
    await expect(bob.getByRole('button', { name: 'Send', exact: true })).toBeEnabled({ timeout: 5000 })
    await bob.getByRole('button', { name: 'Send', exact: true }).click()
    await imageLoaded(bob, 'offline.png'); await imageLoaded(cara, 'offline.png')
    const dialog = await info(bob)
    await expect(dialog.getByText('Encrypted uploads', { exact: true })).toBeVisible()
    await expect(dialog.getByText('No confirmed uploads on this device.', { exact: true })).toBeVisible()
    await expect(dialog.locator('a')).toHaveCount(0)
    await bob.goto('about:blank'); await cara.reload(); await imageLoaded(cara, 'offline.png')
    await cara.screenshot({ path: testInfo.outputPath('offline-group-file.png'), fullPage: true })
  } finally {
    await testInfo.attach('browser-log', { body: logs.join('\n'), contentType: 'text/plain' })
    await Promise.all(contexts.map(context => context.close())); await seed.close()
  }
})

test('message info exposes only acknowledged full ciphertext URLs and copies them', async ({ page, context }, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/'); await page.getByRole('button', { name: 'Go', exact: true }).click()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  const { nip19 } = await import('nostr-tools')
  await page.getByPlaceholder('Paste invite link').fill(nip19.npubEncode('c'.repeat(64)))
  await page.locator('input[type=file]').first().setInputFiles({ name: 'confirmed.png', mimeType: 'image/png', buffer: image })
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const dialog = await info(page)
  const link = dialog.getByTitle('Open encrypted file')
  await expect(link).toHaveAttribute('href', /^https:\/\/upload\.iris\.to\/[a-f0-9]{64}\.bin$/)
  const url = (await link.getAttribute('href'))!
  await expect(link).toHaveText(url)
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  await dialog.getByRole('button', { name: 'Copy encrypted file URL', exact: true }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url)
  expect(url).not.toContain('nhash'); expect(url).not.toContain('#')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: testInfo.outputPath('encrypted-upload-info-mobile.png'), fullPage: true })
})

test('a restarted cached group member seeds another member without a direct chat while the sender is offline', async ({ browser, testRelayUrl }, testInfo) => {
  test.setTimeout(120_000)
  const seed = await startLocalFipsWebSocketSeed()
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()])
  const logs: string[] = []
  const state = (page: Page) => page.evaluate(() => new Promise<{ owner: string; peers: string[]; decisions: { chatId: string; decision: string }[] }>((resolve, reject) => {
    const request = indexedDB.open('iris-chat')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction(['sessionManager', 'sessions'])
      const owner = tx.objectStore('sessionManager').get('v1/device-manager/owner-pubkey')
      const sessions = tx.objectStore('sessions').getAll()
      tx.oncomplete = () => {
        const pubkey = owner.result?.value as string
        const decisions = JSON.parse(localStorage.getItem(`iris-chat-message-request-decisions:${pubkey}`) || '[]')
        db.close(); resolve({ owner: pubkey, peers: sessions.result.map(session => session.recipientPubkey), decisions })
      }
      tx.onerror = () => { db.close(); reject(tx.error) }
    }
  }))
  try {
    for (const context of contexts) {
      await useTestRelay(context, testRelayUrl)
      await context.addInitScript(url => {
        localStorage.setItem('iris-chat-call-servers', JSON.stringify({ servers: [url], stunServers: [] }))
        window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, { construct() { throw new Error('Use routed encrypted file transport') } })
      }, seed.url)
    }
    const [alice, bob, cara] = await Promise.all(contexts.map(context => context.newPage()))
    for (const [index, page] of [alice, bob, cara].entries()) {
      page.on('console', message => logs.push(`${index}: ${message.text()}`))
      page.on('pageerror', error => logs.push(`${index}: ${error.message}`))
    }
    await alice.goto('/'); await alice.getByLabel('Your name (optional)').fill('Alice')
    await alice.getByRole('button', { name: 'Go', exact: true }).click()
    const copy = alice.locator('button[title*="#/nhash"]').first(); await expect(copy).toBeVisible()
    const link = (await copy.getAttribute('title'))!.replace('https://chat.iris.to', new URL(alice.url()).origin)
    for (const [page, name] of [[bob, 'Bob'], [cara, 'Cara']] as const) {
      await page.goto(link); await page.getByLabel('Your name (optional)').fill(name)
      await page.getByRole('button', { name: 'Join Chat', exact: true }).click()
      await send(page, `Hello from ${name}`)
      await expect(alice.getByTestId('sidebar-chat-list').getByText(`Hello from ${name}`, { exact: true })).toBeVisible()
    }
    await alice.getByRole('button', { name: 'New Chat', exact: true }).click()
    await alice.getByRole('button', { name: 'Create Group', exact: true }).click()
    for (const name of ['Bob', 'Cara']) await alice.getByTestId('create-group-member').filter({ has: alice.getByText(name, { exact: true }) }).click()
    await alice.getByTestId('create-group-next').click()
    await alice.getByPlaceholder('Enter group name...').fill('Cached group files')
    await alice.getByTestId('create-group-submit').click(); await send(alice, 'Group ready')
    for (const page of [bob, cara]) {
      await page.getByTestId('sidebar-chat-list').getByRole('button', { name: /Cached group files/ }).click()
      await page.getByRole('button', { name: 'Accept', exact: true }).click()
      await send(page, page === bob ? 'Bob ready' : 'Cara ready')
    }
    await expect(bob.getByText('Cara ready', { exact: true }).last()).toBeVisible()
    await expect(cara.getByText('Bob ready', { exact: true }).last()).toBeVisible()
    const noDirectAcceptance = async () => {
      const [b, c] = await Promise.all([state(bob), state(cara)])
      expect(b.owner).toMatch(/^[a-f0-9]{64}$/); expect(c.owner).toMatch(/^[a-f0-9]{64}$/)
      expect(b.owner).not.toBe(c.owner)
      expect(b.peers).not.toContain(c.owner); expect(c.peers).not.toContain(b.owner)
      expect(b.decisions.find(item => item.chatId === c.owner)?.decision).not.toBe('accepted')
      expect(c.decisions.find(item => item.chatId === b.owner)?.decision).not.toBe('accepted')
    }
    await noDirectAcceptance()
    await expect.poll(() => seed.connectedPeers().length).toBe(3)
    const caraUrl = cara.url()
    await cara.goto('about:blank')
    await expect.poll(() => seed.connectedPeers().length).toBe(2)
    for (const context of contexts) await context.route(/^https:\/\/(?:upload|cdn)\.iris\.to\//, route => route.abort())
    await alice.locator('input[type=file]').first().setInputFiles({ name: 'seeded.png', mimeType: 'image/png', buffer: image })
    await alice.getByRole('button', { name: 'Send', exact: true }).click()
    await imageLoaded(bob, 'seeded.png')
    await alice.goto('about:blank')
    await bob.reload(); await imageLoaded(bob, 'seeded.png')
    // Cached rendering precedes device startup. Require the restored seed to rejoin first.
    await expect.poll(() => seed.connectedPeers().length).toBe(1)
    await cara.goto(caraUrl)
    await imageLoaded(cara, 'seeded.png')
    expect(await cara.getByAltText('seeded.png').evaluate(async element => Array.from(new Uint8Array(await (await fetch((element as HTMLImageElement).src)).arrayBuffer())))).toEqual([...image])
    await noDirectAcceptance()
    await cara.screenshot({ path: testInfo.outputPath('cached-group-member.png'), fullPage: true })
  } finally {
    await testInfo.attach('browser-log', { body: logs.join('\n'), contentType: 'text/plain' })
    await Promise.all(contexts.map(context => context.close())); await seed.close()
  }
})

import { test, expect, useTestRelay } from './fixtures'
import type { BrowserContext, Page } from '@playwright/test'
import { startLocalFipsWebSocketSeed } from './fixtures/localFipsWebSocketSeed'
import { readFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'

test('three browsers share cached encrypted files on the existing FIPS node with Blossom unavailable', async ({ browser, testRelayUrl, baseURL }) => {
  // Two added reload/file phases retain the existing readiness and file limits.
  test.setTimeout(300_000)
  const seed = await startLocalFipsWebSocketSeed()
  const contexts: BrowserContext[] = []
  const logs: string[] = []
  const devicePeerIds = new Map<Page, string>()
  let sharingFiles = false
  async function user() {
    const alreadyConnected = new Set(seed.connectedPeers())
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], serviceWorkers: 'block' })
    contexts.push(context)
    await useTestRelay(context, testRelayUrl)
    await context.addInitScript(url => {
      localStorage.setItem('iris-chat-call-servers', JSON.stringify({ servers: [url], stunServers: [] }))
      window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
        construct() { throw new Error('Direct WebRTC disabled: test uses the existing routed FIPS node') },
      })
    }, seed.url)
    await context.route('**/*', route => {
      if (['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)) return route.continue()
      // Private invite exchange uses the local encrypted-blob fixture; file
      // transfer below still has every external Blossom request blocked.
      if (!sharingFiles && /^https:\/\/(upload|cdn)\.iris\.to\//.test(route.request().url())) return route.fallback()
      return route.abort()
    })
    await context.routeWebSocket('**/*', socket => [seed.url, testRelayUrl].includes(socket.url().replace(/\/$/, '')) ? socket.connectToServer() : socket.close())
    const page = await context.newPage()
    page.on('console', message => logs.push(message.text()))
    page.on('pageerror', error => logs.push(error.message))
    await page.goto(baseURL!)
    await page.getByRole('button', { name: 'Go', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Devices', exact: true }).click()
    await expect(async () => {
      const register = page.getByRole('button', { name: 'Register this device' })
      if (await register.isVisible()) await register.click()
      await expect(page.getByText('This device', { exact: true }).first()).toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(page).toHaveURL(/#settings$/)
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect.poll(() => seed.connectedPeers().filter(id => !alreadyConnected.has(id))).toHaveLength(1)
    devicePeerIds.set(page, seed.connectedPeers().find(id => !alreadyConnected.has(id))!)
    return page
  }
  async function connect(a: Page, b: Page, greeting: string) {
    await a.getByRole('button', { name: 'New Chat', exact: true }).click()
    const copy = a.locator('button[title*="#"]').first()
    await expect(copy).toBeVisible()
    const invite = (await copy.getAttribute('title'))!.replace('https://chat.iris.to', baseURL!)
    await b.getByRole('button', { name: 'New Chat', exact: true }).click()
    await b.getByPlaceholder('Paste invite link').fill(invite)
    await b.getByPlaceholder('Type a message...').fill(greeting)
    await b.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(async () => {
      for (const tab of ['sidebar-tab-all', 'sidebar-tab-requests']) {
        await a.getByTestId(tab).click()
        const row = a.getByTestId('sidebar-chat-list').getByRole('button', { name: new RegExp(greeting) }).first()
        if (await row.isVisible()) { await row.click(); return }
      }
      throw new Error('Waiting for invitation')
    }).toPass({ timeout: 30_000 })
    const accept = a.getByTestId('request-accept-chat')
    if (await accept.isVisible()) await accept.click()
    await a.getByPlaceholder('Type a message...').fill(`Accepted ${greeting}`)
    await a.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(b.getByText(`Accepted ${greeting}`, { exact: true }).first()).toBeVisible()
  }
  async function imageBytes(page: Page) {
    const image = page.getByAltText('peer.jpg')
    await expect(image).toBeVisible({ timeout: 30_000 })
    return image.evaluate(async element => Array.from(new Uint8Array(await (await fetch((element as HTMLImageElement).src)).arrayBuffer())))
  }
  try {
    const a = await user(), b = await user(), c = await user()
    await connect(a, b, 'First peer')
    sharingFiles = true
    const bytes = [...readFileSync(new URL('./fixtures/test-blob.jpeg', import.meta.url))]
    await a.locator('input[type=file]').first().setInputFiles({ name: 'peer.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(bytes) })
    await expect(a.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    await a.getByRole('button', { name: 'Send', exact: true }).click()
    expect(await imageBytes(b)).toEqual(bytes)
    const bubble = b.locator('.max-w-\\[85\\%\\]').filter({ has: b.getByAltText('peer.jpg') })
    await bubble.hover()
    await bubble.getByRole('button', { name: 'Message menu' }).click()
    await b.getByRole('button', { name: 'Copy', exact: true }).click()
    const link = await b.evaluate(() => navigator.clipboard.readText())
    expect(link).toMatch(/nhash1/)
    const initialPeerIds = [a, b, c].map(page => devicePeerIds.get(page)!)
    expect(new Set(initialPeerIds).size).toBe(3)
    // Keep the original routed transport and HTTP restrictions. Only the sender
    // owns each random file, generated after that browser has actually reloaded.
    for (const [endpoint, sender, receiver] of [[0, a, b], [1, b, a]] as const) {
      await sender.reload()
      await sender.getByTestId('sidebar-chat-list').getByRole('button').first().click()
      await expect(sender.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 30_000 })
      await expect.poll(() => seed.connectedPeers().slice().sort()).toEqual(initialPeerIds.slice().sort())
      const filename = `recovered-${endpoint}.jpg`
      const freshBytes = Buffer.concat([Buffer.from(bytes), randomBytes(32)])
      const freshHash = createHash('sha256').update(freshBytes).digest('hex')
      await expect(receiver.getByAltText(filename)).toHaveCount(0)
      await sender.locator('input[type=file]').first().setInputFiles({
        name: filename, mimeType: 'image/jpeg', buffer: freshBytes,
      })
      await expect(sender.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
      await sender.getByRole('button', { name: 'Send', exact: true }).click()
      const receivedImage = receiver.getByAltText(filename)
      await expect(receivedImage).toBeVisible({ timeout: 30_000 })
      const received = await receivedImage.evaluate(async element => {
        const url = new URL((element as HTMLImageElement).src)
        if (url.protocol !== 'blob:') throw new Error('Peer image must render from its downloaded local bytes')
        const data = await (await fetch(url.href)).arrayBuffer()
        return {
          bytes: data.byteLength,
          hash: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)),
            byte => byte.toString(16).padStart(2, '0')).join(''),
        }
      })
      expect(received).toEqual({ bytes: freshBytes.length, hash: freshHash })
      // The seed authenticates the real browser endpoints. A rotated or extra
      // endpoint must not masquerade as retention of the registered device ID.
      await expect.poll(() => seed.connectedPeers().slice().sort()).toEqual(initialPeerIds.slice().sort())
      console.log('PEER_RELOAD_RECOVERY', JSON.stringify({
        app: 'iris-chat', endpoint, reloaded: true, identityPreserved: true,
        peerRecovered: true, freshHash, bytes: received.bytes, transport: 'routed-fips',
      }))
    }
    await a.context().close()
    await b.reload()
    await b.getByTestId('sidebar-chat-list').getByRole('button').first().click()
    expect(await imageBytes(b)).toEqual(bytes)
    // Cached pixels render before device initialization rejoins the network.
    // Forward only once the restored provider and third browser are connected.
    await expect.poll(() => seed.connectedPeers().length).toBe(2)
    await b.getByRole('button', { name: 'Back', exact: true }).click()
    sharingFiles = false
    await connect(b, c, 'Cached peer')
    sharingFiles = true
    await b.getByPlaceholder('Type a message...').fill(link)
    await b.getByRole('button', { name: 'Send', exact: true }).click()
    expect(await imageBytes(c)).toEqual(bytes)
  } finally {
    await test.info().attach('peer-log', { body: logs.join('\n'), contentType: 'text/plain' })
    await Promise.all(contexts.map(context => context.close()))
    await seed.close()
  }
})

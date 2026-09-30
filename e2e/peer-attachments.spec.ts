import { test, expect, useTestRelay } from './fixtures'
import type { BrowserContext, Page } from '@playwright/test'
import { startLocalFipsWebSocketSeed } from './fixtures/localFipsWebSocketSeed'
import { readFileSync } from 'node:fs'

test('three browsers share cached encrypted files on the existing FIPS node with Blossom unavailable', async ({ browser, testRelayUrl, baseURL }) => {
  test.setTimeout(120_000)
  const seed = await startLocalFipsWebSocketSeed()
  const contexts: BrowserContext[] = []
  const logs: string[] = []
  async function user() {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], serviceWorkers: 'block' })
    contexts.push(context)
    await useTestRelay(context, testRelayUrl)
    await context.addInitScript(url => {
      localStorage.setItem('iris-chat-call-servers', JSON.stringify({ servers: [url], stunServers: [] }))
      window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
        construct() { throw new Error('Direct WebRTC disabled: test uses the existing routed FIPS node') },
      })
    }, seed.url)
    await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
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
    await a.context().close()
    await b.reload()
    await b.getByTestId('sidebar-chat-list').getByRole('button').first().click()
    expect(await imageBytes(b)).toEqual(bytes)
    await b.getByRole('button', { name: 'Back', exact: true }).click()
    await connect(b, c, 'Cached peer')
    await b.getByPlaceholder('Type a message...').fill(link)
    await b.getByRole('button', { name: 'Send', exact: true }).click()
    expect(await imageBytes(c)).toEqual(bytes)
  } finally {
    await test.info().attach('peer-log', { body: logs.join('\n'), contentType: 'text/plain' })
    await Promise.all(contexts.map(context => context.close()))
    await seed.close()
  }
})

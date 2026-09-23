import { test, expect, useTestRelay } from './fixtures'
import { chromium, type BrowserContext, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { startLocalFipsWebSocketSeed } from './fixtures/localFipsWebSocketSeed'
import { TestRelay } from './test-relay'

test('two browsers route voice and video through an intermediate FIPS node when direct connections are unavailable', async ({ baseURL }) => {
  test.setTimeout(120000)
  const seed = await startLocalFipsWebSocketSeed()
  const relay = new TestRelay()
  await relay.start()
  let relayStopped = false
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
  const contexts: BrowserContext[] = []
  const logs: string[] = []
  const evidence: Record<string, unknown>[] = []
  async function user() {
    const context = await browser.newContext({ baseURL, permissions: ['microphone', 'camera'], serviceWorkers: 'block', viewport: { width: 1100, height: 780 } })
    contexts.push(context)
    await useTestRelay(context, relay.url)
    await context.addInitScript(seed => {
      localStorage.setItem('iris-chat-call-servers', JSON.stringify({ servers: [seed], stunServers: [] }))
      const evidence = { blockedRtc: 0, isRtcBlocked: () => window.RTCPeerConnection === blockedConstructor }
      const blockedConstructor = new Proxy(window.RTCPeerConnection, {
        construct() { evidence.blockedRtc++; throw new Error('Direct WebRTC connections disabled for routed FIPS test') },
      })
      Object.assign(window, { routedCallEvidence: evidence })
      window.RTCPeerConnection = blockedConstructor
    }, seed.url)
    await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
    const allowedSockets = [new URL(seed.url).origin, new URL(relay.url).origin]
    await context.routeWebSocket('**/*', socket => {
      if (allowedSockets.includes(new URL(socket.url()).origin)) socket.connectToServer()
      else socket.close()
    })
    const page = await context.newPage()
    const index = contexts.length
    page.on('console', message => logs.push(`${index}: ${message.text()}`))
    page.on('pageerror', error => logs.push(`${index} ERROR: ${error.message}`))
    await page.goto('/')
    await page.getByRole('button', { name: 'Go', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const register = page.getByRole('button', { name: 'Register this device' })
    await expect(async () => {
      if (await register.isVisible()) await register.click()
      await expect(page.getByText('This device', { exact: true }).first()).toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 30000 })
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    return page
  }
  async function sample(page: Page) {
    return {
      audio: Number(await page.getByTestId('call-screen').getAttribute('data-audio-frames')),
      video: Number(await page.getByTestId('call-screen').getAttribute('data-video-frames')),
      energy: Number(await page.getByTestId('call-screen').getAttribute('data-audio-energy')),
      ...await page.evaluate(() => {
        const evidence = (window as Window & { routedCallEvidence?: { blockedRtc: number; isRtcBlocked: () => boolean } }).routedCallEvidence
        return { blockedRtc: evidence?.blockedRtc ?? 0, rtcProhibited: evidence?.isRtcBlocked() ?? false }
      }),
    }
  }
  try {
    const a = await user(), b = await user()
    await a.getByRole('button', { name: 'New Chat', exact: true }).click()
    const invite = (await a.locator('button[title*="#"]').first().getAttribute('title'))!.replace('https://chat.iris.to', baseURL!)
    await b.getByRole('button', { name: 'New Chat', exact: true }).click()
    await b.getByPlaceholder('Paste invite link').fill(invite)
    await b.getByPlaceholder('Type a message...').fill('Routed call ready')
    await b.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(async () => {
      for (const tab of ['sidebar-tab-all', 'sidebar-tab-requests']) {
        await a.getByTestId(tab).click()
        const item = a.getByTestId('sidebar-chat-list').getByRole('button', { name: /Routed call ready/ }).first()
        if (await item.isVisible()) { await item.click(); return }
      }
      throw new Error('Waiting for chat')
    }).toPass({ timeout: 30000 })
    if (await a.getByTestId('request-accept-chat').isVisible()) await a.getByTestId('request-accept-chat').click()
    await a.getByRole('button', { name: 'Video call', exact: true }).click()
    await expect(b.getByRole('button', { name: 'Answer with video' })).toBeVisible()
    await b.getByRole('button', { name: 'Answer with video' }).click()
    for (const page of [a, b]) {
      await expect(page.getByTestId('call-screen')).toHaveAttribute('data-status', 'active')
      await expect.poll(async () => (await sample(page)).audio).toBeGreaterThan(10)
      await expect.poll(async () => (await sample(page)).video).toBeGreaterThan(10)
      await expect.poll(async () => (await sample(page)).energy).toBeGreaterThan(0.01)
      expect((await sample(page)).rtcProhibited).toBe(true)
      await expect.poll(() => page.getByLabel('Caller video').locator('canvas').evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBeGreaterThanOrEqual(640)
    }
    // Only the caller may attempt a direct upgrade; the callee can remain routed.
    await expect.poll(async () => (await Promise.all([a, b].map(sample))).reduce((sum, peer) => sum + peer.blockedRtc, 0)).toBeGreaterThan(0)
    evidence.push({ phase: 'routed-call', peers: await Promise.all([a, b].map(sample)) })
    await relay.stop()
    relayStopped = true
    // Sample only after the message server is completely closed. The remaining
    // path is browser -> intermediate FIPS WebSocket node -> other browser.
    const afterClose = await Promise.all([a, b].map(sample))
    evidence.push({ phase: 'message-server-closed', peers: afterClose })
    for (const [index, page] of [a, b].entries()) {
      await expect.poll(async () => (await sample(page)).audio).toBeGreaterThan(afterClose[index].audio + 50)
      await expect.poll(async () => (await sample(page)).video).toBeGreaterThan(afterClose[index].video + 45)
      await expect(page.getByTestId('call-screen')).toHaveAttribute('data-status', 'active')
    }
    evidence.push({ phase: 'continued-through-fips-node', peers: await Promise.all([a, b].map(sample)) })
    await mkdir('work/calls-routed', { recursive: true })
    await a.screenshot({ path: 'work/calls-routed/active-video.png' })
    await a.getByRole('button', { name: 'End call', exact: true }).click()
    await expect(b.getByTestId('call-screen')).toHaveAttribute('data-status', 'ended')
    for (const page of [a, b]) {
      await page.getByRole('button', { name: 'Done', exact: true }).click()
      await expect(page.locator('[data-testid="call-history-row"][data-outcome="answered"]')).toHaveCount(1)
    }
    await expect(a.getByTestId('call-history-row')).toContainText('Outgoing video call')
    await expect(b.getByTestId('call-history-row')).toContainText('Incoming video call')
  } finally {
    await mkdir('work/calls-routed', { recursive: true })
    await writeFile('work/calls-routed/browser.log', logs.join('\n'))
    await writeFile('work/calls-routed/evidence.json', JSON.stringify(evidence, null, 2))
    await Promise.all(contexts.map(context => context.close()))
    await browser.close()
    await seed.close()
    if (!relayStopped) await relay.stop()
  }
})

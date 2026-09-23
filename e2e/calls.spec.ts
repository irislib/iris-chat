import { test, expect, useTestRelay } from './fixtures'
import { chromium, type Page, type BrowserContext } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { startLocalFipsWebSocketSeed } from './fixtures/localFipsWebSocketSeed'

test('voice and video over local FIPS with Internet blocked, voice answer and call preferences', async ({ testRelayUrl, testRelay, baseURL }) => {
  test.setTimeout(180000)
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] })
  const seed = await startLocalFipsWebSocketSeed()
  const contexts: BrowserContext[] = []
  const logs: string[] = []
  async function user() {
    const context = await browser.newContext({ baseURL, permissions: ['microphone', 'camera'], viewport: { width: 1100, height: 780 }, serviceWorkers: 'block' })
    contexts.push(context)
    await useTestRelay(context, testRelayUrl)
    await context.addInitScript(url => { localStorage.setItem('iris-chat-call-servers', JSON.stringify({ servers: [url] })) }, seed.url)
    await context.addInitScript(() => {
      const evidence = { played: 0, nonSilent: 0, streams: [] as MediaStream[], peers: [] as RTCPeerConnection[] }
      ;(window as unknown as { callEvidence: typeof evidence }).callEvidence = evidence
      const start = AudioBufferSourceNode.prototype.start
      AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
        if (this.buffer?.sampleRate === 16000 && this.buffer.length === 320) {
          evidence.played++
          if (this.buffer.getChannelData(0).some(v => Math.abs(v) > 0.001)) evidence.nonSilent++
        }
        return start.apply(this, args)
      }
      const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await getMedia(constraints); evidence.streams.push(stream); return stream
      }
      const Peer = window.RTCPeerConnection
      window.RTCPeerConnection = class extends Peer { constructor(config?: RTCConfiguration) { super(config); evidence.peers.push(this) } }
    })
    // Block all Internet HTTP and WebSocket traffic, including service workers.
    await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
    await context.routeWebSocket('**/*', socket => {
      if (['127.0.0.1', 'localhost'].includes(new URL(socket.url()).hostname)) socket.connectToServer()
      else socket.close()
    })
    const page = await context.newPage()
    const userIndex = contexts.length
    page.on('console', message => logs.push(`${userIndex}: ${message.text()}`))
    page.on('pageerror', error => logs.push(`${userIndex} ERROR: ${error.message}`))
    await page.goto('/')
    await page.getByRole('button', { name: 'Go', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Devices', exact: true })).toBeVisible()
    const register = page.getByRole('button', { name: 'Register this device' })
    await expect(async () => {
      if (await register.isVisible()) await register.click()
      await expect(page.getByText('This device', { exact: true }).first()).toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 30000 })
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    return page
  }
  async function send(page: Page, text: string) {
    await page.getByPlaceholder('Type a message...').fill(text)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
  }
  async function start(a: Page, b: Page, video: boolean) {
    await expect(async () => {
      await a.getByRole('button', { name: video ? 'Video call' : 'Voice call', exact: true }).click()
      if (await a.getByRole('button', { name: 'Dismiss call error' }).isVisible()) { logs.push(await a.getByRole('alert').innerText()); await a.getByRole('button', { name: 'Dismiss call error' }).click() }
      await expect(b.getByTestId('call-screen')).toHaveAttribute('data-status', 'ringing', { timeout: 2000 })
    }).toPass({ timeout: 30000 })
  }
  async function received(page: Page, type: 'audio' | 'video') {
    await expect.poll(async () => Number(await page.getByTestId('call-screen').getAttribute(`data-${type}-frames`))).toBeGreaterThan(5)
  }
  async function hangup(a: Page, b: Page) {
    await a.getByRole('button', { name: 'End call', exact: true }).click()
    await expect(b.getByTestId('call-screen')).toHaveAttribute('data-status', 'ended')
    for (const page of [a, b]) {
      await page.getByRole('button', { name: 'Done', exact: true }).click()
      expect(await page.evaluate(() => (window as unknown as { callEvidence: { streams: MediaStream[] } }).callEvidence.streams.every(s => s.getTracks().every(t => t.readyState === 'ended')))).toBe(true)
    }
  }
  try {
    const a = await user(), b = await user()
    await a.getByRole('button', { name: 'New Chat', exact: true }).click()
    const copy = a.locator('button[title*="#"]').first()
    await expect(copy).toBeVisible()
    const invite = (await copy.getAttribute('title'))!.replace('https://chat.iris.to', baseURL!)
    await b.getByRole('button', { name: 'New Chat', exact: true }).click()
    await b.getByPlaceholder('Paste invite link').fill(invite)
    await send(b, 'Local call ready')
    await expect(async () => {
      for (const tab of ['sidebar-tab-all', 'sidebar-tab-requests']) {
        await a.getByTestId(tab).click()
        const item = a.getByTestId('sidebar-chat-list').getByRole('button', { name: /Local call ready/ }).first()
        if (await item.isVisible()) { await item.click(); return }
      }
      throw new Error('Waiting for chat')
    }).toPass({ timeout: 30000 })
    if (await a.getByTestId('request-accept-chat').isVisible()) await a.getByTestId('request-accept-chat').click()
    await start(a, b, false)
    await b.getByRole('button', { name: 'Answer call', exact: true }).click()
    await received(a, 'audio'); await received(b, 'audio')
    for (const page of [a, b]) await expect.poll(() => page.evaluate(() => (window as unknown as { callEvidence: { nonSilent: number } }).callEvidence.nonSilent)).toBeGreaterThan(3)
    await a.getByRole('button', { name: 'Mute microphone' }).click()
    await expect(a.getByRole('button', { name: 'Unmute microphone' })).toBeVisible()
    await a.getByRole('button', { name: 'Unmute microphone' }).click()
    await hangup(a, b)
    await start(a, b, true)
    await mkdir('work/calls', { recursive: true })
    await b.screenshot({ path: 'work/calls/incoming-video.png' })
    await b.getByRole('button', { name: 'Answer with video' }).click()
    await received(a, 'audio'); await received(b, 'audio')
    await received(a, 'video'); await received(b, 'video')
    await a.screenshot({ path: 'work/calls/active-video.png' })
    // A live encrypted call continues after the discovery/message server is gone.
    await testRelay.stop()
    for (const page of [a, b]) {
      await expect.poll(async () => Number(await page.getByTestId('call-screen').getAttribute('data-video-frames'))).toBeGreaterThan(35)
      await expect(page.getByAltText('Caller video')).toBeVisible()
      expect(await page.evaluate(() => (window as unknown as { callEvidence: { peers: RTCPeerConnection[] } }).callEvidence.peers.every(p => !p.getConfiguration().iceServers?.length))).toBe(true)
    }
    await a.getByRole('button', { name: 'Turn camera off' }).click()
    await expect(a.getByRole('button', { name: 'Turn camera on' })).toBeVisible()
    await hangup(a, b)
    await start(a, b, true)
    await b.getByRole('button', { name: 'Answer with voice' }).click()
    await received(a, 'audio'); await received(b, 'audio')
    await expect(a.getByRole('button', { name: 'Turn camera off' })).toHaveCount(0)
    await expect(b.getByRole('button', { name: 'Turn camera off' })).toHaveCount(0)
    await expect(a.getByTestId('call-screen')).toHaveAttribute('data-video-frames', '0')
    await hangup(a, b)
    await b.getByRole('button', { name: 'Settings', exact: true }).click()
    await b.getByRole('switch', { name: 'Video calls', exact: true }).click()
    await b.getByRole('switch', { name: 'Voice calls', exact: true }).click()
    await b.reload()
    await expect(b.getByRole('switch', { name: 'Voice calls', exact: true })).toHaveAttribute('aria-checked', 'false')
    await expect(b.getByRole('switch', { name: 'Video calls', exact: true })).toHaveAttribute('aria-checked', 'false')
  } finally { await mkdir('work/calls', { recursive: true }); await writeFile('work/calls/browser.log', logs.join('\n')); await Promise.all(contexts.map(c => c.close())); await browser.close(); await seed.close() }
})

import { test, expect, useTestRelay } from './fixtures'
import { chromium, type BrowserContext, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { startLocalFipsWebSocketSeed } from './fixtures/localFipsWebSocketSeed'
import { TestRelay } from './test-relay'

declare global {
  interface Window {
    screenShareProbe: { mode: string; requests: DisplayMediaStreamOptions[]; streams: MediaStream[]; selected: MediaStream[]; grant?: () => void }
  }
}

test('shares selected screen pixels over the existing call and restores camera state safely', async ({ baseURL }) => {
  test.setTimeout(150000)
  const seed = await startLocalFipsWebSocketSeed()
  const relay = new TestRelay()
  await relay.start()
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
    // Only source selection is simulated. The production encoder, audio,
    // authenticated FIPS transport, decoder, controls and cleanup run unchanged.
    await context.addInitScript(() => {
      const probe = { mode: 'success', requests: [] as DisplayMediaStreamOptions[], streams: [] as MediaStream[], selected: [] as MediaStream[], grant: undefined as (() => void) | undefined }
      Object.assign(window, { screenShareProbe: probe })
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async options => {
        const stream = await getUserMedia(options); probe.streams.push(stream); return stream
      }
      navigator.mediaDevices.getDisplayMedia = async options => {
        probe.requests.push(options!)
        if (probe.mode === 'cancel') throw new DOMException('Cancelled', 'NotAllowedError')
        const capture = () => {
          const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720
          const draw = () => {
            const ctx = canvas.getContext('2d')!
            ctx.fillStyle = '#b32657'; ctx.fillRect(0, 0, 1280, 720)
            ctx.fillStyle = 'white'; ctx.font = '48px sans-serif'; ctx.fillText('Shared screen', 70, 90)
          }
          draw()
          const stream = canvas.captureStream(15)
          const timer = setInterval(draw, 60)
          stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer), { once: true })
          probe.selected.push(stream)
          return stream
        }
        if (probe.mode === 'pending') return new Promise<MediaStream>(resolve => { probe.grant = () => resolve(capture()) })
        return capture()
      }
    })
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
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Devices', exact: true }).click()
    const register = page.getByRole('button', { name: 'Register this device' })
    await expect(async () => {
      if (await register.isVisible()) await register.click()
      await expect(page.getByText('This device', { exact: true }).first()).toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 30000 })
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(page).toHaveURL(/#settings$/)
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
    expect(await a.evaluate(() => window.screenShareProbe.requests.length)).toBe(0)
    const audioIdentity = await a.evaluate(() => window.screenShareProbe.streams[0].getAudioTracks()[0].id)
    await a.getByRole('button', { name: 'Turn camera off' }).click()
    await a.evaluate(() => { window.screenShareProbe.mode = 'cancel' })
    await a.getByRole('button', { name: 'Share screen', exact: true }).click()
    await expect(a.getByRole('button', { name: 'Share screen', exact: true })).toBeEnabled()
    await expect(a.getByRole('button', { name: 'Turn camera on' })).toBeEnabled()
    await expect(a.getByText('Sharing your screen', { exact: true })).toBeHidden()
    await a.evaluate(() => { window.screenShareProbe.mode = 'success' })
    const beforeSharing = await sample(b)
    await a.getByRole('button', { name: 'Share screen', exact: true }).click()
    await expect(a.getByRole('button', { name: 'Stop sharing', exact: true })).toBeVisible()
    await expect(a.getByText('Sharing your screen', { exact: true })).toBeVisible()
    await expect(a.getByRole('button', { name: 'Stop sharing to use the camera' })).toBeDisabled()
    await expect(a.getByLabel('Your screen')).toHaveCSS('transform', 'none')
    await expect.poll(() => b.getByLabel('Caller video').locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
      const [r, g, b] = canvas.getContext('2d')!.getImageData(320, 300, 1, 1).data
      return r > 150 && r < 210 && g < 70 && b > 50 && b < 120
    })).toBe(true)
    await expect.poll(async () => (await sample(b)).audio).toBeGreaterThan(beforeSharing.audio + 50)
    await expect.poll(async () => (await sample(b)).energy).toBeGreaterThan(beforeSharing.energy)
    expect(await a.evaluate(() => {
      const probe = window.screenShareProbe
      return { audio: probe.streams[0].getAudioTracks()[0].id, camera: probe.streams[0].getVideoTracks()[0].enabled, constraints: probe.requests.at(-1) }
    })).toEqual({ audio: audioIdentity, camera: false, constraints: { video: { frameRate: { ideal: 15, max: 15 } }, audio: false } })
    await mkdir('work/web-screen-sharing', { recursive: true })
    await a.screenshot({ path: 'work/web-screen-sharing/sharing-desktop.png' })
    await b.screenshot({ path: 'work/web-screen-sharing/receiving-desktop.png' })
    await a.setViewportSize({ width: 320, height: 568 })
    await expect(a.getByRole('button', { name: 'Stop sharing', exact: true })).toBeInViewport()
    await expect(a.getByRole('button', { name: 'End call', exact: true })).toBeInViewport()
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await a.screenshot({ path: 'work/web-screen-sharing/sharing-small.png' })
    await a.setViewportSize({ width: 1100, height: 780 })
    await a.getByRole('button', { name: 'Stop sharing', exact: true }).click()
    await expect(a.getByRole('button', { name: 'Turn camera on' })).toBeEnabled()
    await expect(a.getByLabel('Your camera')).toBeHidden()
    expect(await a.evaluate(() => window.screenShareProbe.selected[0].getVideoTracks()[0].readyState)).toBe('ended')
    expect(await a.evaluate(() => window.screenShareProbe.streams[0].getVideoTracks()[0].enabled)).toBe(false)
    // Browser-provided Stop sharing has the same cleanup and camera restore.
    await a.getByRole('button', { name: 'Turn camera on' }).click()
    await a.getByRole('button', { name: 'Share screen', exact: true }).click()
    await expect(a.getByRole('button', { name: 'Stop sharing', exact: true })).toBeVisible()
    await a.evaluate(() => { const track = window.screenShareProbe.selected.at(-1)!.getVideoTracks()[0]; track.stop(); track.dispatchEvent(new Event('ended')) })
    await expect(a.getByRole('button', { name: 'Turn camera off' })).toBeEnabled()
    await expect(a.getByLabel('Your camera')).toBeVisible()
    await expect.poll(() => b.getByLabel('Caller video').locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
      const [r, g, b] = canvas.getContext('2d')!.getImageData(320, 300, 1, 1).data
      return !(r > 150 && r < 210 && g < 70 && b > 50 && b < 120)
    })).toBe(true)
    // A picker completing after Hang up must release the selected display.
    await a.evaluate(() => { window.screenShareProbe.mode = 'pending' })
    await a.getByRole('button', { name: 'Share screen', exact: true }).click()
    await expect(a.getByRole('button', { name: 'Share screen', exact: true })).toBeDisabled()
    await a.getByRole('button', { name: 'End call', exact: true }).click()
    await expect(a.getByTestId('call-screen')).toBeHidden()
    await a.evaluate(() => window.screenShareProbe.grant!())
    await expect.poll(() => a.evaluate(() => window.screenShareProbe.selected.at(-1)!.getVideoTracks()[0].readyState)).toBe('ended')
    await expect(b.getByTestId('call-screen')).toBeHidden()
    evidence.push({ phase: 'screen-shared-audio-continued-camera-restored-late-picker-released', audioIdentityUnchanged: true })
  } finally {
    await mkdir('work/web-screen-sharing', { recursive: true })
    await writeFile('work/web-screen-sharing/browser.log', logs.join('\n'))
    await writeFile('work/web-screen-sharing/evidence.json', JSON.stringify(evidence, null, 2))
    await Promise.all(contexts.map(context => context.close()))
    await browser.close()
    await seed.close()
    await relay.stop()
  }
})

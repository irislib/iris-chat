import { test, expect, useTestRelay } from './fixtures'
import { chromium, type Page, type BrowserContext } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { startLocalFipsWebSocketSeed } from './fixtures/localFipsWebSocketSeed'
import { startSilentStunServer } from './fixtures/silentStunServer'
import { TestRelay } from './test-relay'

test('voice and video continue directly over FIPS with STUN unavailable and servers stopped', async ({ baseURL }) => {
  test.setTimeout(240000)
  const bandwidth: Record<string, unknown>[] = []
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] })
  const seed = await startLocalFipsWebSocketSeed()
  const stun = await startSilentStunServer()
  // Stop both bootstrap servers during the call, independently of other tests.
  const testRelay = new TestRelay()
  await testRelay.start()
  const testRelayUrl = testRelay.url
  let relayStopped = false
  let seedStopped = false
  const directEvidence: Record<string, unknown>[] = []
  const rtcBeforeReload: unknown[] = []
  const contexts: BrowserContext[] = []
  const logs: string[] = []
  async function user() {
    const context = await browser.newContext({ baseURL, permissions: ['microphone', 'camera'], viewport: { width: 1100, height: 780 }, serviceWorkers: 'block' })
    contexts.push(context)
    await useTestRelay(context, testRelayUrl)
    await context.addInitScript(({ seed, stun }) => {
      localStorage.setItem('iris-chat-call-servers', JSON.stringify({ servers: [seed], stunServers: [stun] }))
    }, { seed: seed.url, stun: stun.url })
    await context.addInitScript(() => {
      const evidence = { streams: [] as MediaStream[], peers: [] as RTCPeerConnection[], rate: Infinity, dropEvery: 0 }
      ;(window as unknown as { callEvidence: typeof evidence }).callEvidence = evidence
      const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await getMedia(constraints); evidence.streams.push(stream); return stream
      }
      const sendData = RTCDataChannel.prototype.send
      const limits = new WeakMap<RTCDataChannel, { allowance: number; at: number; packets: number }>()
      RTCDataChannel.prototype.send = function(data: string | Blob | ArrayBuffer | ArrayBufferView) {
        if (typeof data === 'string') { sendData.call(this, data); return }
        const now = performance.now(), size = data instanceof Blob ? data.size : data.byteLength
        const limit = limits.get(this) ?? { allowance: 10000, at: now, packets: 0 }
        limit.allowance = Number.isFinite(evidence.rate) ? Math.min(10000, limit.allowance + (now - limit.at) * evidence.rate / 1000) : Infinity
        limit.at = now; limit.packets++; limits.set(this, limit)
        if ((evidence.dropEvery && limit.packets % evidence.dropEvery === 0) || size > limit.allowance) return
        limit.allowance -= size
        sendData.call(this, data as ArrayBuffer)
      }
      const Peer = window.RTCPeerConnection
      window.RTCPeerConnection = class extends Peer {
        constructor(config?: RTCConfiguration) {
          super(config)
          const id = evidence.peers.length
          evidence.peers.push(this)
          const description = (value?: { type?: RTCSdpType; sdp?: string } | null) => ({
            type: value?.type, ufrag: value?.sdp?.match(/^a=ice-ufrag:(.+)$/m)?.[1]?.trim(),
          })
          const trace = (method: string, extra = {}) => console.debug('Call RTC trace', JSON.stringify({
            at: Date.now(), id, method, connection: this.connectionState, signaling: this.signalingState, ...extra,
          }))
          trace('created')
          const createOffer = this.createOffer.bind(this)
          this.createOffer = (async (options?: RTCOfferOptions) => {
            trace('createOffer:start')
            const result = await createOffer(options)
            trace('createOffer:done', description(result))
            return result
          }) as typeof this.createOffer
          const createAnswer = this.createAnswer.bind(this)
          this.createAnswer = (async (options?: RTCAnswerOptions) => {
            trace('createAnswer:start')
            const result = await createAnswer(options)
            trace('createAnswer:done', description(result))
            return result
          }) as typeof this.createAnswer
          const setLocal = this.setLocalDescription.bind(this)
          this.setLocalDescription = (async (value?: RTCLocalSessionDescriptionInit) => {
            trace('setLocal:start', description(value))
            await setLocal(value)
            trace('setLocal:done', description(this.localDescription))
          }) as typeof this.setLocalDescription
          const setRemote = this.setRemoteDescription.bind(this)
          this.setRemoteDescription = (async (value: RTCSessionDescriptionInit) => {
            trace('setRemote:start', description(value))
            await setRemote(value)
            trace('setRemote:done', description(this.remoteDescription))
          }) as typeof this.setRemoteDescription
          const close = this.close.bind(this)
          this.close = () => { trace('close'); close() }
          this.addEventListener('icecandidateerror', event => trace('icecandidateerror', { code: event.errorCode, error: event.errorText }))
          for (const event of ['connectionstatechange', 'icegatheringstatechange', 'signalingstatechange']) {
            this.addEventListener(event, () => trace(event, { gathering: this.iceGatheringState }))
          }
        }
      }
    })
    // Block all Internet HTTP and WebSocket traffic, including service workers.
    await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
    await context.routeWebSocket('**/*', socket => {
      if (!['127.0.0.1', 'localhost'].includes(new URL(socket.url()).hostname)) { socket.close(); return }
      socket.connectToServer()
    })
    const page = await context.newPage()
    const userIndex = contexts.length
    page.on('console', message => logs.push(`${userIndex} @ ${Date.now()}: ${message.text()}`))
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
    try {
      await expect(async () => {
        if (!await a.getByTestId('call-screen').isVisible()) {
          await a.getByRole('button', { name: video ? 'Video call' : 'Voice call', exact: true }).click()
          if (await a.getByRole('button', { name: 'Dismiss call error' }).isVisible()) { logs.push(await a.getByRole('alert').innerText()); await a.getByRole('button', { name: 'Dismiss call error' }).click() }
        }
        await expect(b.getByTestId('call-screen')).toHaveAttribute('data-status', 'ringing', { timeout: 2000 })
      }).toPass({ timeout: 30000 })
    } catch (error) {
      await mkdir('work/calls', { recursive: true })
      for (const [index, page] of [a, b].entries()) {
        await writeFile(`work/calls/start-failure-${index + 1}.json`, JSON.stringify({
          at: Date.now(), body: (await page.locator('body').innerText()).slice(-6000),
          call: await page.getByTestId('call-screen').evaluateAll(elements => elements[0]?.getAttribute('data-status') ?? null),
          history: await page.getByTestId('call-history-row').allTextContents(),
        }, null, 2))
      }
      throw error
    }
  }
  async function received(page: Page, type: 'audio' | 'video') {
    await expect.poll(async () => Number(await page.getByTestId('call-screen').getAttribute(`data-${type}-frames`))).toBeGreaterThan(5)
  }
  async function rtcSnapshot(page: Page) {
    return page.evaluate(async () => {
      const peers = (window as unknown as { callEvidence: { peers: RTCPeerConnection[] } }).callEvidence.peers
      return Promise.all(peers.map(async peer => ({
        state: peer.connectionState, local: peer.localDescription, remote: peer.remoteDescription,
        configuration: peer.getConfiguration(), stats: [...(await peer.getStats()).values()],
      })))
    })
  }
  async function directStats(page: Page) {
    const peers = await rtcSnapshot(page)
    const pairs = peers.filter(peer => peer.state === 'connected').flatMap(peer => peer.stats)
      .filter(stat => stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated)
    return {
      connected: peers.some(peer => peer.state === 'connected'),
      received: pairs.reduce((sum, pair) => sum + Number(pair.bytesReceived ?? 0), 0),
      sent: pairs.reduce((sum, pair) => sum + Number(pair.bytesSent ?? 0), 0),
    }
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
    async function shape(rate: number, dropEvery = 0) {
      if (!seedStopped) seed.shape(rate, dropEvery)
      for (const page of [a, b]) await page.evaluate(({ rate, dropEvery }) => { const e = (window as unknown as { callEvidence: { rate: number; dropEvery: number } }).callEvidence; e.rate = rate; e.dropEvery = dropEvery }, { rate, dropEvery })
    }
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
    for (const page of [a, b]) await expect.poll(async () => Number(await page.getByTestId('call-screen').getAttribute('data-audio-energy'))).toBeGreaterThan(0.01)
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
    for (const page of [a, b]) {
      await page.getByRole('button', { name: 'Call quality', exact: true }).click()
      await page.getByRole('combobox', { name: 'Call quality' }).selectOption('high')
      await page.getByRole('button', { name: 'Call quality', exact: true }).click()
    }
    for (const page of [a, b]) {
      await expect.poll(() => page.getByLabel('Caller video').locator('canvas').evaluate((canvas: HTMLCanvasElement) => ({ width: canvas.width, height: canvas.height }))).toEqual({ width: 1280, height: 720 })
      bandwidth.push({ phase: 'high-quality-capture', tracks: await page.evaluate(() => (window as unknown as { callEvidence: { streams: MediaStream[] } }).callEvidence.streams.flatMap(s => s.getVideoTracks()).filter(t => t.readyState === 'live').map(t => t.getSettings())) })
    }
    await a.screenshot({ path: 'work/calls/active-video.png' })
    // Real UDP STUN receives requests but sends no replies; HTTP interception
    // alone cannot establish this. Only local host candidates can succeed.
    await expect.poll(stun.requests).toBeGreaterThan(0)
    for (const page of [a, b]) {
      await expect.poll(async () => (await directStats(page)).received).toBeGreaterThan(65536)
      const peers = await rtcSnapshot(page)
      expect(peers.some(peer => peer.state === 'connected')).toBe(true)
      for (const peer of peers) {
        expect(peer.configuration.iceServers?.flatMap(server => typeof server.urls === 'string' ? [server.urls] : server.urls)).toEqual([stun.url])
        expect(peer.stats.filter(stat => stat.type === 'local-candidate' || stat.type === 'remote-candidate')
          .every(candidate => candidate.candidateType === 'host')).toBe(true)
      }
    }
    const beforeCutoff = await Promise.all([a, b].map(async page => ({
      audio: Number(await page.getByTestId('call-screen').getAttribute('data-audio-frames')),
      video: Number(await page.getByTestId('call-screen').getAttribute('data-video-frames')),
      ...await directStats(page),
    })))
    directEvidence.push({ phase: 'before-server-cutoff', stunRequests: stun.requests(), peers: beforeCutoff })
    await testRelay.stop()
    relayStopped = true
    await seed.close()
    seedStopped = true
    for (const [index, page] of [a, b].entries()) {
      // Count newly decoded media well beyond queued frames, in both directions.
      await expect.poll(async () => Number(await page.getByTestId('call-screen').getAttribute('data-audio-frames'))).toBeGreaterThan(beforeCutoff[index].audio + 50)
      await expect.poll(async () => Number(await page.getByTestId('call-screen').getAttribute('data-video-frames'))).toBeGreaterThan(beforeCutoff[index].video + 45)
      await expect.poll(async () => (await directStats(page)).received).toBeGreaterThan(beforeCutoff[index].received + 65536)
      await expect(page.getByTestId('call-screen')).toHaveAttribute('data-status', 'active')
      await expect(page.getByLabel('Caller video')).toBeVisible()
      await expect.poll(() => page.getByLabel('Caller video').locator('canvas').evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBeGreaterThanOrEqual(1280)
      expect(await page.evaluate(() => (window as unknown as { callEvidence: { peers: RTCPeerConnection[] } }).callEvidence.peers.every(p => p.getSenders().every(sender => !sender.track)))).toBe(true)
    }
    directEvidence.push({ phase: 'after-server-cutoff', stunRequests: stun.requests(), relayStopped, seedStopped,
      peers: await Promise.all([a, b].map(async page => ({
        audio: Number(await page.getByTestId('call-screen').getAttribute('data-audio-frames')),
        video: Number(await page.getByTestId('call-screen').getAttribute('data-video-frames')),
        ...await directStats(page),
      }))),
    })
    const senderStats = async () => ({ target: Number(await a.getByTestId('call-screen').getAttribute('data-target-bitrate')), bytes: Number(await a.getByTestId('call-screen').getAttribute('data-sent-bytes')), at: Date.now() })
    await expect.poll(async () => (await senderStats()).target).toBeGreaterThan(600000)
    bandwidth.push({ phase: 'unrestricted', ...await senderStats() })
    const beforeLoss = Number(await b.getByTestId('call-screen').getAttribute('data-video-frames'))
    await shape(Infinity, 100)
    await expect.poll(async () => Number(await b.getByTestId('call-screen').getAttribute('data-video-frames'))).toBeGreaterThan(beforeLoss + 30)
    await shape(Infinity)
    const beforeLimitedFrames = Number(await b.getByTestId('call-screen').getAttribute('data-video-frames'))
    await shape(50000) // 400 kbit/s on direct FIPS data channels, including encrypted overhead.
    await expect.poll(async () => { const sample = await senderStats(); bandwidth.push({ phase: 'limited', ...sample }); return sample.target }, { timeout: 40000 }).toBeLessThan(450000)
    await expect.poll(async () => Number(await b.getByTestId('call-screen').getAttribute('data-video-frames'))).toBeGreaterThan(beforeLimitedFrames + 10)
    const constrained = await senderStats()
    await shape(Infinity)
    await expect.poll(async () => { const sample = await senderStats(); bandwidth.push({ phase: 'restored', ...sample }); return sample.target }, { timeout: 40000 }).toBeGreaterThan(Math.max(500000, constrained.target * 1.3))
    // Change the real sender's cap live; stats verify the engine applies it.
    await a.getByRole('button', { name: 'Call quality', exact: true }).click()
    await a.getByRole('combobox', { name: 'Call quality' }).selectOption('custom')
    await a.getByRole('spinbutton', { name: 'Video limit (kbps)' }).fill('250')
    await a.getByRole('spinbutton', { name: 'Video limit (kbps)' }).press('Tab')
    await expect.poll(async () => (await senderStats()).target).toBeLessThanOrEqual(250000)
    await a.screenshot({ path: 'work/calls/video-quality.png' })
    await a.getByRole('button', { name: 'Call quality', exact: true }).click()
    // Interrupt FIPS packet forwarding, then verify media recovers without ending the call.
    await shape(0)
    await new Promise(resolve => setTimeout(resolve, 2000))
    const frozen = Number(await a.getByTestId('call-screen').getAttribute('data-video-frames'))
    await shape(Infinity)
    await expect.poll(async () => Number(await a.getByTestId('call-screen').getAttribute('data-video-frames'))).toBeGreaterThan(frozen + 10)
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
    for (const page of [a, b]) {
      await expect(page.locator('[data-testid="call-history-row"][data-outcome="answered"]')).toHaveCount(3)
      await expect(page.getByTestId('call-history-row').nth(2)).toContainText('voice call')
    }
    await start(a, b, false)
    await hangup(a, b) // Caller cancels before answer: a missed call for the recipient.
    await expect(a.getByTestId('call-history-row').last()).toContainText('Canceled voice call')
    await expect(b.getByTestId('call-history-row').last()).toContainText('Missed voice call')
    for (const page of [a, b]) {
      await expect(page.getByTestId('call-history-row')).toHaveCount(4)
      rtcBeforeReload.push(await rtcSnapshot(page))
      await page.reload()
      await page.getByTestId('sidebar-chat-list').getByRole('button', { name: /(?:Canceled|Missed) voice call/ }).first().click()
      await expect(page.getByTestId('call-history-row')).toHaveCount(4)
      await expect(page.locator('[data-testid="call-history-row"][data-outcome="answered"]')).toHaveCount(3)
    }
    await expect(b.getByTestId('call-history-row').last()).toContainText('Missed voice call')
    await b.screenshot({ path: 'work/calls/chat-call-history.png' })
    await b.getByRole('button', { name: 'Settings', exact: true }).click()
    await b.getByRole('switch', { name: 'Video calls', exact: true }).click()
    await b.getByRole('switch', { name: 'Voice calls', exact: true }).click()
    await b.reload()
    await expect(b.getByRole('switch', { name: 'Voice calls', exact: true })).toHaveAttribute('aria-checked', 'false')
    await expect(b.getByRole('switch', { name: 'Video calls', exact: true })).toHaveAttribute('aria-checked', 'false')
  } finally {
    await mkdir('work/calls', { recursive: true })
    directEvidence.push({ phase: 'finished', stunRequests: stun.requests(), relayStopped, seedStopped })
    const finalRtc = await Promise.all(contexts.map(async context => {
      const page = context.pages()[0]
      return page ? rtcSnapshot(page).catch(() => []) : []
    }))
    await writeFile('work/calls/rtc-evidence.json', JSON.stringify([...rtcBeforeReload, ...finalRtc], null, 2))
    await writeFile('work/calls/direct-path.json', JSON.stringify(directEvidence, null, 2))
    await writeFile('work/calls/browser.log', logs.join('\n'))
    await writeFile('work/calls/bandwidth.json', JSON.stringify(bandwidth, null, 2))
    await Promise.all(contexts.map(c => c.close()))
    await browser.close()
    if (!seedStopped) await seed.close()
    if (!relayStopped) await testRelay.stop()
    await stun.close()
  }
})

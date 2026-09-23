import { test, expect, useTestRelay } from './fixtures'
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createServer, createConnection, type AddressInfo } from 'node:net'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getPublicKey, generateSecretKey } from 'nostr-tools'

// cargo build --features stack-fixture --bin iris-call-fixture in iris-chat-rs/core
const fixture = process.env.IRIS_CALL_FIXTURE_BIN

test('browser and native exchange voice/video over local FIPS without a media server', async ({ testRelayUrl, baseURL }) => {
  test.setTimeout(180000)
  if (!fixture || !existsSync(fixture)) {
    if (process.env.REQUIRE_CALL_INTEROP === '1') throw new Error('Set IRIS_CALL_FIXTURE_BIN to the built native call fixture')
    test.skip(true, 'Set IRIS_CALL_FIXTURE_BIN to run native call interoperability')
    return
  }
  const reservation = createServer()
  await new Promise<void>(r => reservation.listen(0, '127.0.0.1', r))
  const port = (reservation.address() as AddressInfo).port
  await new Promise<void>(r => reservation.close(() => r()))
  await mkdir('work/calls', { recursive: true })
  const data = await mkdtemp(resolve('work/calls/native-'))
  const native = spawn(fixture, [data], { env: { ...process.env, IRIS_DEMO_RELAYS: testRelayUrl, IRIS_FIPS_WEBSOCKET_SEED_URLS: '', IRIS_CHAT_FIPS_WEBSOCKET_BIND_ADDR: `127.0.0.1:${port}`, IRIS_CHAT_SAME_HOST_HASHTREE: '0' }, stdio: ['pipe', 'pipe', 'pipe'] })
  const events: Array<Record<string, any>> = []
  let stderr = ''
  native.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-20000) })
  createInterface({ input: native.stdout }).on('line', line => { try { const event = JSON.parse(line); events.push(event) } catch { /* Non-JSON runtime diagnostics. */ } })
  const command = (text: string) => native.stdin.write(`${text}\n`)
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] })
  const key = generateSecretKey(), owner = getPublicKey(key)
  const context = await browser.newContext({ baseURL, permissions: ['microphone', 'camera'], serviceWorkers: 'block', viewport: { width: 1100, height: 780 } })
  const logs: string[] = []
  try {
    await expect.poll(() => events.find(e => e.event === 'ready'), { timeout: 40000 }).toBeTruthy()
    const ready = events.find(e => e.event === 'ready')!
    await expect.poll(() => new Promise<boolean>(resolve => { const socket = createConnection({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(true) }); socket.once('error', () => resolve(false)) }), { timeout: 30000 }).toBe(true)
    await useTestRelay(context, testRelayUrl)
    await context.addInitScript(({ seed, key }) => {
      localStorage.setItem('iris-chat-call-servers', JSON.stringify({ servers: [seed] }))
      localStorage.setItem('iris-chat-identity', key)
    }, { seed: `ws://127.0.0.1:${port}/fips`, key: Buffer.from(key).toString('hex') })
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
    await context.routeWebSocket('**/*', socket => { if (new URL(socket.url()).hostname === '127.0.0.1') socket.connectToServer(); else socket.close() })
    await context.addInitScript((disableRtc) => {
      const Original = window.RTCPeerConnection
      const events: Array<{ event: string, connection?: string, ice?: string }> = []
      Object.assign(window, { __nativeInteropRtc: events })
      window.RTCPeerConnection = class extends Original {
        constructor(configuration?: RTCConfiguration) {
          if (disableRtc) { events.push({ event: 'disabled' }); throw new Error('WebRTC disabled for FIPS route isolation') }
          super(configuration)
          events.push({ event: 'created' })
          for (const event of ['connectionstatechange', 'iceconnectionstatechange']) {
            this.addEventListener(event, () => events.push({ event, connection: this.connectionState, ice: this.iceConnectionState }))
          }
        }
      }
    }, process.env.CALL_INTEROP_WS_ONLY === '1')
    const page = await context.newPage()
    page.on('console', message => logs.push(message.text()))
    page.on('pageerror', error => logs.push(error.message))
    await page.goto('/')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Devices', exact: true })).toBeVisible()
    const register = page.getByRole('button', { name: 'Register this device' })
    await expect(async () => {
      if (await register.isVisible()) await register.click()
      await expect(page.getByText('This device', { exact: true }).first()).toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 30000 })
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    await page.getByPlaceholder('Paste invite link').fill(ready.invite)
    await page.getByPlaceholder('Type a message...').fill('Local native call')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    command(`accept ${owner}`)
    await expect.poll(() => events.some(e => e.event === 'accepted')).toBe(true)
    await expect(async () => {
      if (!await page.getByTestId('call-screen').isVisible()) {
        await page.getByRole('button', { name: 'Video call', exact: true }).click()
        const dismiss = page.getByRole('button', { name: 'Dismiss call error' })
        if (await dismiss.isVisible()) { logs.push(await page.getByRole('alert').innerText()); await dismiss.click() }
      }
      await expect(page.getByTestId('call-screen')).toHaveAttribute('data-status', 'active', { timeout: 4000 })
    }).toPass({ timeout: 40000 })
    for (const kind of ['audio', 'video']) {
      await expect.poll(async () => Number(await page.getByTestId('call-screen').getAttribute(`data-${kind}-frames`))).toBeGreaterThan(5)
    }
    await expect.poll(async () => Number(await page.getByTestId('call-screen').getAttribute('data-audio-energy'))).toBeGreaterThan(0.01)
    command('status')
    await expect.poll(() => events.some(event => Number(event.nonzero_audio_frames) > 5)).toBe(true)
    await page.screenshot({ path: 'work/calls/native-browser-video.png' })
    await page.getByRole('button', { name: 'End call', exact: true }).click()
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.getByTestId('call-history-row')).toHaveCount(1)
    await expect(page.getByTestId('call-history-row')).toContainText('Outgoing video call')
    command(`call ${owner} video`)
    await expect(page.getByRole('button', { name: 'Answer with voice' })).toBeVisible()
    await page.getByRole('button', { name: 'Answer with voice' }).click()
    await expect(page.getByTestId('call-screen')).toHaveAttribute('data-status', 'active')
    await expect(page.getByRole('button', { name: 'Turn camera off' })).toHaveCount(0)
    await expect.poll(async () => Number(await page.getByTestId('call-screen').getAttribute('data-audio-frames'))).toBeGreaterThan(5)
    await expect(page.getByTestId('call-screen')).toHaveAttribute('data-video-frames', '0')
    command('end')
    command('status')
    await expect(page.getByTestId('call-screen')).toHaveAttribute('data-status', 'ended')
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.getByTestId('call-history-row').last()).toContainText('Incoming voice call')
    command(`call ${owner} voice`)
    await expect(page.getByTestId('call-screen')).toHaveAttribute('data-status', 'ringing')
    command('end')
    await expect(page.getByTestId('call-screen')).toHaveAttribute('data-status', 'ended')
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.getByTestId('call-history-row').last()).toContainText('Missed voice call')
    await expect(page.getByTestId('call-history-row')).toHaveCount(3)
    await page.reload()
    await page.getByTestId('sidebar-chat-list').getByRole('button', { name: /Missed voice call/ }).first().click()
    await expect(page.getByTestId('call-history-row')).toHaveCount(3)
    await expect(page.getByTestId('call-history-row').last()).toContainText('Missed voice call')
    await page.screenshot({ path: 'work/calls/native-chat-call-history.png' })
    await writeFile('work/calls/native-evidence.json', JSON.stringify(events, null, 2))
  } finally {
    const rtc = await context.pages()[0]?.evaluate(() => (window as Window & { __nativeInteropRtc?: unknown }).__nativeInteropRtc).catch(() => [])
    await writeFile('work/calls/native-rtc.json', JSON.stringify(rtc, null, 2))
    await writeFile('work/calls/native-evidence.json', JSON.stringify(events, null, 2))
    await writeFile('work/calls/native-browser.log', logs.join('\n'))
    await writeFile('work/calls/native-runtime.log', stderr)
    await Promise.all([
      writeFile(resolve(data, 'browser.log'), logs.join('\n')),
      writeFile(resolve(data, 'events.json'), JSON.stringify(events, null, 2)),
      writeFile(resolve(data, 'rtc.json'), JSON.stringify(rtc ?? [], null, 2)),
    ])
    command('stop')
    await context.close(); await browser.close()
    const exited = new Promise<void>(r => native.once('exit', () => r()))
    await Promise.race([exited, new Promise<void>(r => setTimeout(r, 3000))])
    if (native.exitCode === null) native.kill('SIGTERM')
  }
})

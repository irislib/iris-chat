import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test, expect, useTestRelay } from './fixtures'
import { startLocalFipsWebSocketSeed } from './fixtures/localFipsWebSocketSeed'
import { TestRelay } from './test-relay'

const execute = promisify(execFile)

for (const routedOnly of [false, true]) {
  test(`native approval links a browser and transfers history ${routedOnly ? 'through a FIPS seed without WebRTC' : 'with an unavailable server'}`, async ({ browser, testRelayUrl }, testInfo) => {
    test.setTimeout(240_000)
    const core = process.env.IRIS_CHAT_RS_CORE_DIR
    if (!core) {
      if (process.env.REQUIRE_NATIVE_INTEROP === '1') throw new Error('Native source is required')
      test.skip(true, 'Set IRIS_CHAT_RS_CORE_DIR for native linking interoperability')
      return
    }
    const binary = process.env.IRIS_CHAT_RS_BIN ?? path.join(core, 'target/debug/iris')
    expect(existsSync(binary), 'Build the selected native CLI before running interop').toBe(true)
    const directory = mkdtempSync(path.join(tmpdir(), 'iris-native-link-'))
    const seed = await startLocalFipsWebSocketSeed()
    const missingAck = new TestRelay()
    missingAck.acknowledgeFilter = event => event.kind !== 24133
    await missingAck.start()
    const relays = [testRelayUrl, 'ws://127.0.0.1:1', missingAck.url]
    const env = { ...process.env, IRIS_DEMO_RELAYS: relays.join(','), NOSTR_PREFER_LOCAL: '0',
      IRIS_FIPS_WEBSOCKET_SEED_URLS: seed.url,
      ...(routedOnly ? { IRIS_CHAT_FIPS_ENABLE_WEBRTC: '0' } : {}) }
    writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ relays }))
    const args = ['--json', '--data-dir', directory]
    const run = async (...command: string[]) => {
      const { stdout } = await execute(binary, [...args, ...command], { env, timeout: 210_000, maxBuffer: 1024 * 1024 })
      const result = JSON.parse(stdout)
      expect(result.status, JSON.stringify(result)).toBe('ok')
      return result.data
    }
    let service: ChildProcess | undefined
    let serviceErrors = ''
    const diagnostics: string[] = []
    const context = await browser.newContext()
    try {
      service = spawn(binary, [...args, 'service', 'run'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      service.stderr!.on('data', data => { serviceErrors = (serviceErrors + data).slice(-16_000) })
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Native service did not start')), 20_000)
        service!.once('exit', () => { clearTimeout(timeout); reject(new Error(serviceErrors)) })
        service!.stdout!.on('data', data => { if (String(data).includes('"ready":true')) { clearTimeout(timeout); resolve() } })
      })
      const account = await run('account', 'create', '--name', 'Link history test')
      const owner = account.user_id
      expect(typeof owner, JSON.stringify(account)).toBe('string')
      const body = 'A message written on the phone before linking'
      await run('send', owner, body)
      expect((await run('read', owner)).messages.some((message: { body: string }) => message.body === body)).toBe(true)

      if (routedOnly) await context.addInitScript(() => {
        // Force the production TCP stream to use a routed path through the seed.
        window.RTCPeerConnection = class { constructor() { throw new Error('Direct WebRTC disabled by routed-path test') } } as unknown as typeof RTCPeerConnection
      })
      await useTestRelay(context, relays)
      await context.addInitScript(url => localStorage.setItem('iris-chat-call-servers', JSON.stringify({ servers: [url], stunServers: [] })), seed.url)
      const page = await context.newPage()
      page.on('console', message => { if (diagnostics.length < 300) diagnostics.push(message.text()) })
      page.on('pageerror', error => diagnostics.push(error.message))
      await page.goto('/')
      await page.getByRole('button', { name: 'Link this device', exact: true }).click()
      const code = page.locator('button[title^="nostrconnect://"]')
      await expect(code).toBeVisible()
      const link = (await code.getAttribute('title'))!
      const approval = run('link', 'accept', link, '--include-message-history')
      await expect(page.getByRole('button', { name: 'New Chat', exact: true })).toBeVisible({ timeout: 110_000 })
      const accepted = await approval
      expect(accepted.device_roster.device_count).toBe(2)
      const chat = page.getByTestId('sidebar-chat-list').getByRole('button').filter({ hasText: body })
      await expect(chat).toBeVisible({ timeout: 60_000 })
      await chat.click()
      await expect(page.getByTestId('message-bubble-body').filter({ hasText: body })).toHaveCount(1)
      await page.screenshot({ path: testInfo.outputPath('native-linked-history.png'), fullPage: true })
      await page.reload()
      await chat.click()
      await expect(page.getByTestId('message-bubble-body').filter({ hasText: body })).toHaveCount(1)
    } finally {
      await testInfo.attach('connection-diagnostics', { body: JSON.stringify({ diagnostics, seedPeers: seed.connectedPeers(), serviceErrors }, null, 2), contentType: 'application/json' })
      await context.close()
      if (service?.exitCode === null) {
        await run('service', 'stop').catch(() => service?.kill())
        if (service.exitCode === null) await new Promise<void>(resolve => {
          const timer = setTimeout(() => service?.kill('SIGKILL'), 5000)
          service!.once('exit', () => { clearTimeout(timer); resolve() })
        })
      }
      await seed.close()
      await missingAck.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })

}

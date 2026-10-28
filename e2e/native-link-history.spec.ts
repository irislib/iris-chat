import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools'
import { test, expect, useTestRelay } from './fixtures'
import { startLocalFipsWebSocketSeed } from './fixtures/localFipsWebSocketSeed'
import { TestRelay } from './test-relay'

const execute = promisify(execFile)

for (const route of ['direct', 'native-dials', 'browser-dials'] as const) {
  const routedOnly = route !== 'direct'
  test(`native approval links a browser and transfers history ${routedOnly ? `through a FIPS seed without WebRTC (${route})` : 'with an unavailable server'}`, async ({ browser, testRelay, testRelayUrl }, testInfo) => {
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
        .catch(error => { throw new Error(`Native ${command.slice(0, 2).join(' ')} failed: ${error.stdout || error.stderr || error.message}
${serviceErrors}`) })
      const result = JSON.parse(stdout)
      expect(result.status, JSON.stringify(result)).toBe('ok')
      return result.data
    }
    let owner = ''
    let groupChat = ''
    let expectedBrowserDevice: string | undefined
    let service: ChildProcess | undefined
    let serviceErrors = ''
    const diagnostics: string[] = []
    const uploadAuthorizations: Event[] = []
    const context = await browser.newContext()
    context.on('request', request => {
      if (request.method() !== 'PUT' || request.url() !== 'https://upload.iris.to/upload') return
      const auth = request.headers()['authorization']
      if (auth?.startsWith('Nostr ')) uploadAuthorizations.push(JSON.parse(Buffer.from(auth.slice(6), 'base64').toString()))
    })
    try {
      service = spawn(binary, [...args, 'service', 'run'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      service.stderr!.on('data', data => { serviceErrors = (serviceErrors + data).slice(-16_000) })
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Native service did not start')), 20_000)
        service!.once('exit', () => { clearTimeout(timeout); reject(new Error(serviceErrors)) })
        service!.stdout!.on('data', data => { if (String(data).includes('"ready":true')) { clearTimeout(timeout); resolve() } })
      })
      const account = await run('account', 'create', '--name', 'Link history test')
      owner = account.user_id
      expect(typeof owner, JSON.stringify(account)).toBe('string')
      const body = 'A message written on the phone before linking'
      await run('send', owner, body)
      expect((await run('read', owner)).messages.some((message: { body: string }) => message.body === body)).toBe(true)

      const groupName = 'Private mention preferences'
      const created = await run('group', 'create', groupName)
      groupChat = created.groups.find((group: { name: string }) => group.name === groupName).chat_id
      expect(await run('chat', 'mention-notifications', groupChat, 'false')).toEqual({ chat_id: groupChat, enabled: false })

      if (routedOnly) await context.addInitScript(() => {
        // Force the production TCP stream to use a routed path through the seed.
        window.RTCPeerConnection = class { constructor() { throw new Error('Direct WebRTC disabled by routed-path test') } } as unknown as typeof RTCPeerConnection
      })
      await useTestRelay(context, relays)
      await context.addInitScript(url => localStorage.setItem('iris-chat-call-servers', JSON.stringify({ servers: [url], stunServers: [] })), seed.url)
      const page = await context.newPage()
      page.on('console', message => { diagnostics.push(message.text()); if (diagnostics.length > 2000) diagnostics.shift() })
      page.on('pageerror', error => diagnostics.push(error.message))
      await page.goto('/')
      await page.getByRole('button', { name: 'Already have an account?' }).click()
      await page.getByRole('button', { name: 'Link this device', exact: true }).click()
      const code = page.locator('button[title^="nostrconnect://"]')
      await expect(code).toBeVisible()
      const link = (await code.getAttribute('title'))!
      if (routedOnly) {
        // The signer transport key already exists. Supply one random, prechecked
        // key-generation seed for the upcoming authorization device only. All
        // other random calls (and every call after it) retain platform entropy.
        const nativeFirst = route === 'native-dials'
        const random = crypto.getRandomValues.bind(crypto)
        let entropy: number[] = [], device = ''
        for (let attempt = 0; attempt < 4096; attempt++) {
          try {
            crypto.getRandomValues = array => {
              const result = random(array)
              entropy = Array.from(array as Uint8Array)
              return result
            }
            device = getPublicKey(generateSecretKey())
          } finally { crypto.getRandomValues = random }
          if ((account.device_id < device) === nativeFirst) break
        }
        expect(entropy).toHaveLength(48)
        expect((account.device_id < device) === nativeFirst).toBe(true)
        expectedBrowserDevice = device
        await page.evaluate(entropy => {
          const random = crypto.getRandomValues.bind(crypto)
          crypto.getRandomValues = array => {
            if (array instanceof Uint8Array && array.byteLength === entropy.length) {
              crypto.getRandomValues = random
              array.set(entropy)
              return array
            }
            return random(array)
          }
        }, entropy)
        writeFileSync(testInfo.outputPath('stream-ordering.json'), JSON.stringify({ nativeDevice: account.device_id, browserDevice: device, nativeFirst }))
      }
      const approval = run('link', 'accept', link, '--include-message-history')
      await expect(page.getByRole('button', { name: 'New Chat', exact: true })).toBeVisible({ timeout: 110_000 })
      const accepted = await approval
      expect(accepted.device_roster.device_count).toBe(2)
      if (expectedBrowserDevice) expect(accepted.device_roster.devices).toContainEqual(expect.objectContaining({ device_id: expectedBrowserDevice, authorized: true }))
      const chat = page.getByTestId('sidebar-chat-list').getByRole('button').filter({ hasText: body })
      await expect(chat).toBeVisible({ timeout: 60_000 })
      await chat.click()
      await expect(page.getByTestId('message-bubble-body').filter({ hasText: body })).toHaveCount(1)
      await page.screenshot({ path: testInfo.outputPath('native-linked-history.png'), fullPage: true })
      const authorization = await page.evaluate(async () => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('iris-chat'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
        const rows = await new Promise<Array<{key:string;value:any}>>((resolve, reject) => { const request = database.transaction('sessionManager').objectStore('sessionManager').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
        database.close()
        // Public proof metadata only; never export ratchets, private keys or messages.
        return rows.filter(row => row.key.startsWith('authorization-event-v1:') || row.key === 'iris/signer-device-authorization')
          .filter(row => row.value?.kind === 37368 && row.value.tags.some((tag: string[]) => tag[0] === 'type' && tag[1] === 'app_keys_roster_snapshot'))
          .map(({ value }) => ({ id: value.id, pubkey: value.pubkey, createdAt: value.created_at, devices: value.tags.filter((tag: string[]) => tag[0] === 'device') }))
      })
      writeFileSync(testInfo.outputPath('web-rosters-before-reload.json'), JSON.stringify(authorization, null, 2))
      await page.reload()
      await chat.click()
      await expect(page.getByTestId('message-bubble-body').filter({ hasText: body })).toHaveCount(1)

      // The same linked production runtimes reconcile a private kind-7368 setting
      // both ways, independently of sender-visible read receipts or public tags.
      await page.getByTestId('sidebar-chat-list').getByRole('button').filter({ hasText: groupName }).click()
      const openMute = async () => {
        await page.getByRole('button', { name: 'Chat menu', exact: true }).click()
        await page.getByRole('button', { name: 'Mute notifications', exact: true }).click()
      }
      await openMute()
      const mentions = page.getByRole('checkbox', { name: 'Notify me when mentioned', exact: true })
      await expect(mentions).not.toBeChecked()
      await mentions.check()
      await expect(mentions).toBeChecked()
      const preferenceRows = await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('iris-chat'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
        const rows = await new Promise<Array<{key:string;value:unknown}>>((resolve, reject) => { const request = db.transaction('sessionManager').objectStore('sessionManager').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
        db.close(); return rows.filter(row => row.key.includes('mention') || row.key.includes('history-pair'))
      })
      writeFileSync(testInfo.outputPath('web-private-setting-heads.json'), JSON.stringify(preferenceRows,null,2))
      await expect.poll(async () => (await run('chat', 'mention-notifications', groupChat)).enabled, { timeout: 60_000 }).toBe(true)
      expect(await run('chat', 'mention-notifications', groupChat, 'false')).toEqual({ chat_id: groupChat, enabled: false })
      await expect(mentions).not.toBeChecked({ timeout: 60_000 })
      await page.screenshot({ path: testInfo.outputPath('native-web-private-mention-setting.png'), fullPage: true })
      await page.reload()
      await openMute()
      await expect(mentions).not.toBeChecked()
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await page.getByRole('button', { name: 'New Chat', exact: true }).click()
      await expect(page.locator('button[title*="#/nhash1"]')).toBeVisible()
      expect(uploadAuthorizations.some(event => event.pubkey !== owner && event.kind === 24242 && verifyEvent(event))).toBe(true)
    } finally {
      const page = context.pages()[0]
      if (page && !page.isClosed()) {
        const settings = await page.evaluate(async () => {
          const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('iris-chat'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
          const rows = await new Promise<Array<{key:string;value:unknown}>>((resolve, reject) => { const request = database.transaction('sessionManager').objectStore('sessionManager').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
          database.close()
          return rows.filter(row => row.key.startsWith('mention-notifications:') || row.key.startsWith('device-history-pairs:'))
        }).catch(error => ({ error: String(error) }))
        writeFileSync(testInfo.outputPath('web-private-settings-final.json'), JSON.stringify(settings, null, 2))
      }
      writeFileSync(testInfo.outputPath('relay-rosters.json'), JSON.stringify(testRelay.publishedEvents
        .filter(event => event.kind === 37368 && event.pubkey === owner && event.tags.some(tag => tag[0] === 'type' && tag[1] === 'app_keys_roster_snapshot'))
        .map(event => ({ id: event.id, pubkey: event.pubkey, createdAt: event.created_at, devices: event.tags.filter(tag => tag[0] === 'device') })), null, 2))
      if (owner && groupChat) {
        const headKey = `iris-chat-sync-record-v1:${owner}:private-state:` + JSON.stringify(['privateEvent', 'mentionNotifications', groupChat])
        const nativeHead = await execute('python3', ['-c', 'import sqlite3,sys,json; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro", uri=True); print(json.dumps(c.execute("SELECT value FROM app_meta WHERE key=?", (sys.argv[2],)).fetchone()))', path.join(directory, 'core.sqlite3'), headKey]).catch(error => ({ stdout: String(error) }))
        writeFileSync(testInfo.outputPath('native-private-setting-head.json'), nativeHead.stdout)
        const debug = await run('debug', '--wait-ms', '0').catch(error => ({ error: String(error) }))
        writeFileSync(testInfo.outputPath('native-runtime-diagnostics.json'), JSON.stringify(debug, null, 2))
      }
      writeFileSync(testInfo.outputPath('connection-diagnostics.json'), JSON.stringify({ diagnostics, seedPeers: seed.connectedPeers(), serviceErrors, serviceExit: service?.exitCode, serviceSignal: service?.signalCode }, null, 2))
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

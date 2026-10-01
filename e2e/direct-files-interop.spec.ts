import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { BrowserContext, Page } from '@playwright/test'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { AppKeys } from 'nostr-double-ratchet'
import { test, expect, useTestRelay } from './fixtures'
import { GroupFarmDevice } from './group-runtime-farm'
import { startLocalFipsWebSocketSeed } from './fixtures/localFipsWebSocketSeed'
import { buildNativeDirectFiles, NativeDirectFiles } from './fixtures/nativeDirectFiles'

const payloads = [
  { filename: 'empty.txt', bytes: Buffer.alloc(0) },
  { filename: 'binary.bin', bytes: Buffer.from(Array.from({ length: 180123 }, (_, i) => (i * 31) % 251)) },
  { filename: 'notes.txt', bytes: Buffer.from('Browser ↔ native file transfer 🌈\n'.repeat(337)) },
]
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

test.describe('browser ↔ native direct files', () => {
  test.skip(!process.env.IRIS_CHAT_RS_CORE_DIR && process.env.REQUIRE_DIRECT_FILE_INTEROP !== '1',
    'Set IRIS_CHAT_RS_CORE_DIR to run against the native production source')
  let binary: string
  test.beforeAll(async () => { binary = await buildNativeDirectFiles() }, 180000)

  for (const sameOwner of [false, true]) {
    test(`${sameOwner ? 'own distinct devices' : 'different accounts'} transfer multiple files in both directions after acceptance`, async ({ browser, testRelay, testRelayUrl, baseURL }) => {
      test.setTimeout(150000)
      const seed = await startLocalFipsWebSocketSeed()
      const webKey = generateSecretKey(), webOwner = getPublicKey(webKey)
      const nativeKey = sameOwner ? webKey : generateSecretKey()
      const nativeOwner = getPublicKey(nativeKey)
      const control = new GroupFarmDevice(nativeOwner, testRelayUrl, nativeKey)
      let native: NativeDirectFiles | undefined
      let context: BrowserContext | undefined
      const logs: string[] = [], writes: string[] = []
      const offers: string[] = []
      try {
        await control.start()
        await control.register([control])
        const deviceSecret = control.runtime.getDelegateManager()!.getIdentityKey()
        native = new NativeDirectFiles(binary, seed.url, deviceSecret)
        const nativeDevice = (await native.ready).device!
        expect(nativeDevice).toBe(control.runtime.getState().currentDevicePubkey)
        control.runtime.onSessionEvent(rumor => { if (rumor.content.startsWith('iris-direct-file-v1:')) offers.push(rumor.content) })
        context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' })
        await useTestRelay(context, testRelayUrl)
        await context.addInitScript(({ key, seedUrl }) => {
          localStorage.setItem('iris-chat-identity', key)
          localStorage.setItem('iris-chat-call-servers', JSON.stringify({ servers: [seedUrl], stunServers: [] }))
          Object.assign(window, { __directFileHashtreeWrites: [] })
          for (const method of ['add', 'put'] as const) {
            const original = IDBObjectStore.prototype[method]
            IDBObjectStore.prototype[method] = function (...args: Parameters<typeof original>) {
              if (this.transaction.db.name === 'iris-chat-attachments' || /hashtree/i.test(this.transaction.db.name)) {
                ;(window as unknown as { __directFileHashtreeWrites: string[] }).__directFileHashtreeWrites.push(`${this.transaction.db.name}/${this.name}`)
              }
              return original.apply(this, args)
            }
          }
          window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
            construct() { throw new Error('Interop uses the local routed FIPS connection') },
          })
        }, { key: Buffer.from(webKey).toString('hex'), seedUrl: seed.url })
        await context.route('**/*', route => {
          const url = new URL(route.request().url())
          if (['POST', 'PUT', 'PATCH'].includes(route.request().method())) writes.push(url.toString())
          return ['localhost', '127.0.0.1'].includes(url.hostname) ? route.continue() : route.abort()
        })
        await context.routeWebSocket('**/*', socket => [seed.url, testRelayUrl].includes(socket.url().replace(/\/$/, '')) ? socket.connectToServer() : socket.close())
        const page = await context.newPage()
        page.on('console', event => logs.push(event.text()))
        page.on('pageerror', error => logs.push(error.message))
        await page.goto(baseURL!)
        await expect(page.getByRole('button', { name: 'New Chat', exact: true })).toBeVisible()
        await registerBrowser(page)
        await expect.poll(() => testRelay.publishedEvents.filter(event => event.kind === 37368 && event.pubkey === webOwner).length).toBeGreaterThan(0)
        const roster = testRelay.publishedEvents.filter(event => event.kind === 37368 && event.pubkey === webOwner).sort((a, b) => b.created_at - a.created_at)[0]!
        const devices = AppKeys.fromEvent(roster as any, webKey).getAllDevices()
        const webDevice = devices.find(device => device.identityPubkey !== nativeDevice)!.identityPubkey
        expect(webDevice).not.toBe(nativeDevice)
        await expect.poll(() => seed.connectedPeers().length).toBe(2)
        if (sameOwner) {
          await control.runtime.refreshOwnAppKeysFromRelay(nativeOwner, 1000)
          expect(control.runtime.getState().registeredDevices.map(device => device.identityPubkey)).toContain(webDevice)
        }
        const outgoing = await native.command('offer', {
          id: '1'.repeat(32), token: '2'.repeat(64), owner: nativeOwner, recipient: webOwner, peer: webDevice,
          files: payloads.map(file => ({ filename: file.filename, bytes: file.bytes.toString('base64') })),
        })
        await control.sendContact(webOwner, outgoing.body)
        await openChat(page, 'Native direct files')
        const request = page.getByTestId('request-accept-chat')
        if (await request.isVisible()) await request.click()
        const incoming = page.getByTestId(`direct-file-transfer-${'1'.repeat(32)}`)
        await expect(incoming.getByRole('button', { name: 'Accept', exact: true })).toBeVisible()
        await expect(incoming.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0)
        await capture(page, sameOwner, 'before-accept')
        await page.waitForTimeout(350)
        logs.push(`Native seed peers before accept: ${JSON.stringify(await native.command('peers'))}`)
        logs.push(`Seed peers before accept: ${JSON.stringify(seed.connectedPeers())}`)
        expect(native.events.filter(event => ['accepted', 'progress', 'completed'].includes(event.type))).toEqual([])
        expect(await native.command('receivedBytes')).toBe(0)
        expect(await page.evaluate(async () => {
          const root = await navigator.storage.getDirectory()
          try { await root.getDirectoryHandle('iris-chat-direct-files'); return false }
          catch (error) { if (error instanceof DOMException && error.name === 'NotFoundError') return true; throw error }
        })).toBe(true)
        await incoming.getByRole('button', { name: 'Accept', exact: true }).click()
        await expect(incoming.getByRole('status')).not.toHaveText(/Ready to receive|Connecting|Receiving/, { timeout: 45000 })
        expect(await incoming.getByRole('status').textContent(), await incoming.textContent() ?? 'Native transfer').toBe('Received')
        for (const file of payloads) {
          const download = page.waitForEvent('download')
          await incoming.getByRole('button', { name: `Download ${file.filename}`, exact: true }).click()
          const received = readFileSync((await (await download).path())!)
          expect(received.equals(file.bytes)).toBe(true)
          expect(hash(received)).toBe(hash(file.bytes))
        }
        await expect.poll(() => native!.events.filter(event => event.type === 'completed' && event.id === outgoing.offer.id).length).toBe(1)
        await capture(page, sameOwner, 'native-to-browser-complete')

        await page.getByRole('button', { name: 'Attach file', exact: true }).click()
        const chooser = page.waitForEvent('filechooser')
        await page.getByRole('button', { name: 'Send directly', exact: true }).click()
        await (await chooser).setFiles(payloads.map(file => ({ name: file.filename, mimeType: 'application/octet-stream', buffer: file.bytes })))
        await expect(page.getByTestId('direct-file-preview')).toHaveCount(3)
        await page.getByRole('button', { name: 'Send', exact: true }).click()
        await expect.poll(() => offers.some(body => JSON.parse(JSON.parse(body.slice('iris-direct-file-v1:'.length)).content).device === webDevice)).toBe(true)
        const wire = offers.find(body => JSON.parse(JSON.parse(body.slice('iris-direct-file-v1:'.length)).content).device === webDevice)!
        expect(wire).toBeTruthy()
        const parsed = await native.command('parse', { body: wire })
        expect(parsed.owner).toBe(webOwner)
        expect(parsed.recipient).toBe(nativeOwner)
        expect(parsed.device).toBe(webDevice)
        expect(parsed.files.map((file: any) => file.sha256)).toEqual(payloads.map(file => hash(file.bytes)))
        await page.waitForTimeout(350)
        expect(await native.command('receivedBytes')).toBe(0)
        await native.command('receive', { body: wire })
        await expect.poll(() => native!.events.some(event => event.type === 'completed' && event.id === parsed.id), { timeout: 45000 }).toBe(true)
        const received = native.events.find(event => event.type === 'completed' && event.id === parsed.id)!.files!
        expect(received).toHaveLength(payloads.length)
        received.forEach((file, index) => {
          expect(Buffer.from(file.bytes, 'base64').equals(payloads[index]!.bytes)).toBe(true)
          expect(file.sha256).toBe(hash(payloads[index]!.bytes))
        })
        await expect(page.getByTestId(`direct-file-transfer-${parsed.id}`).getByText('Sent', { exact: true })).toBeVisible()
        expect(writes).toEqual([])
        expect(await page.evaluate(() => (window as unknown as { __directFileHashtreeWrites: string[] }).__directFileHashtreeWrites)).toEqual([])
        mkdirSync('work/direct-file-interop', { recursive: true })
        writeFileSync(`work/direct-file-interop/${sameOwner ? 'self' : 'contact'}-evidence.json`, JSON.stringify({
          ok: true, sameOwner, distinctDevices: webDevice !== nativeDevice, transport: 'fips-tcp',
          directions: ['native-to-browser', 'browser-to-native'], bytesBeforeAccept: 0,
          httpWrites: writes.length, attachmentCacheWrites: 0,
          files: payloads.map(file => ({ filename: file.filename, bytes: file.bytes.length, sha256: hash(file.bytes) })),
        }, null, 2))
        await capture(page, sameOwner, 'both-directions-complete')
        await test.info().attach('native-transfer-events', { body: JSON.stringify(native.events, null, 2), contentType: 'application/json' })
      } finally {
        logs.push(`Seed peers at teardown: ${JSON.stringify(seed.connectedPeers())}`)
        mkdirSync('work/direct-file-interop', { recursive: true })
        writeFileSync(`work/direct-file-interop/${sameOwner ? 'self' : 'contact'}-browser.log`, logs.join('\n'))
        if (native) writeFileSync(`work/direct-file-interop/${sameOwner ? 'self' : 'contact'}-native.json`, JSON.stringify(native.events, null, 2))
        await test.info().attach('browser-log', { body: logs.join('\n'), contentType: 'text/plain' })
        await context?.close()
        await native?.close()
        control.stop()
        await seed.close()
      }
    })
  }
})

async function registerBrowser(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Devices', exact: true }).click()
  const register = page.getByRole('button', { name: 'Register this device' })
  if (await register.isVisible()) await register.click()
  await expect(page.getByText('This device', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
}

async function capture(page: Page, sameOwner: boolean, stage: string) {
  mkdirSync('work/direct-file-interop', { recursive: true })
  const path = `work/direct-file-interop/${sameOwner ? 'self' : 'contact'}-${stage}.png`
  await page.screenshot({ path, fullPage: true })
  await test.info().attach(stage, { path, contentType: 'image/png' })
}

async function openChat(page: Page, preview: string) {
  await expect(async () => {
    for (const tab of ['sidebar-tab-all', 'sidebar-tab-requests']) {
      await page.getByTestId(tab).click()
      const row = page.getByTestId('sidebar-chat-list').getByRole('button').filter({ hasText: preview }).first()
      if (await row.isVisible()) { await row.click(); return }
    }
    throw new Error('Waiting for native offer in chat list')
  }).toPass({ timeout: 30000 })
}

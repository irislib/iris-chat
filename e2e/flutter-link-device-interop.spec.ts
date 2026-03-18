import { test, expect, useTestRelay } from './fixtures'
import type { BrowserContext, Page } from '@playwright/test'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FLUTTER_REPO = path.resolve(__dirname, '../../iris-chat-flutter')
const RUN_FLUTTER_INTEROP = process.env.IRIS_FLUTTER_INTEROP === '1'
const FLUTTER_MACOS_APP_BINARY = path.join(
  FLUTTER_REPO,
  'build/macos/Build/Products/Debug/iris chat.app/Contents/MacOS/iris chat'
)

test.describe.configure({ mode: 'serial' })

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function setIdentity(context: BrowserContext, privkeyHex: string) {
  await context.addInitScript((key: string) => {
    try {
      window.localStorage.setItem('iris-chat-identity', key)
    } catch {
      // ignore opaque origins (about:blank)
    }
  }, privkeyHex)
}

async function clearIdentity(context: BrowserContext) {
  await context.addInitScript(() => {
    try {
      window.localStorage.removeItem('iris-chat-identity')
    } catch {
      // ignore opaque origins (about:blank)
    }
  })
}

async function loginWithStoredKey(page: Page) {
  await page.goto('/')
  const newChat = page.getByRole('button', { name: 'New Chat' })
  try {
    await expect(newChat).toBeVisible({ timeout: 30000 })
  } catch {
    const [identity, relays, bodyText] = await Promise.all([
      page.evaluate(() => localStorage.getItem('iris-chat-identity')),
      page.evaluate(() => localStorage.getItem('iris-chat-relays')),
      page.evaluate(() => document.body?.innerText?.slice(0, 500) || ''),
    ])
    throw new Error(
      `Login timeout. identity=${identity} relays=${relays} bodyText=${bodyText}`
    )
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function waitForOwnerAppKeysEventCount(
  testRelay: { publishedEvents: Array<{ kind: number; pubkey: string; tags: string[][] }> },
  ownerPubkeyHex: string,
  minCount: number,
  timeoutMs = 10000
) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const count = testRelay.publishedEvents.filter((event) => {
      if (event.kind !== 30078 || event.pubkey !== ownerPubkeyHex) return false
      return event.tags.some((tag) => tag[0] === 'd' && tag[1] === 'double-ratchet/app-keys')
    }).length

    if (count >= minCount) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  throw new Error(
    `Timed out waiting for owner AppKeys events >= ${minCount} for ${ownerPubkeyHex.slice(0, 8)}`
  )
}

function getOwnerAppKeysEvents(
  testRelay: { publishedEvents: Array<{ kind: number; pubkey: string; tags: string[][] }> },
  ownerPubkeyHex: string
) {
  return testRelay.publishedEvents.filter((event) => {
    if (event.kind !== 30078 || event.pubkey !== ownerPubkeyHex) return false
    return event.tags.some((tag) => tag[0] === 'd' && tag[1] === 'double-ratchet/app-keys')
  })
}

async function waitForLatestOwnerAppKeysDeviceCount(
  testRelay: { publishedEvents: Array<{ kind: number; pubkey: string; tags: string[][] }> },
  ownerPubkeyHex: string,
  minDeviceCount: number,
  timeoutMs = 10000
) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const latest = getOwnerAppKeysEvents(testRelay, ownerPubkeyHex).at(-1)
    const deviceCount =
      latest?.tags.filter((tag) => tag[0] === 'device' && tag[1]?.trim().length > 0).length ?? 0

    if (deviceCount >= minDeviceCount) {
      return latest
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  throw new Error(
    `Timed out waiting for latest owner AppKeys to include >= ${minDeviceCount} devices for ${ownerPubkeyHex.slice(0, 8)}`
  )
}

async function waitForRelayConnectionCount(
  relay: { totalConnections: number },
  minConnectionCount: number,
  timeoutMs = 10000
) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (relay.totalConnections >= minConnectionCount) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  throw new Error(
    `Timed out waiting for relay connections >= ${minConnectionCount}; got ${relay.totalConnections}`
  )
}

async function waitForNextCreatedAtSecond(): Promise<void> {
  const currentSecond = Math.floor(Date.now() / 1000)
  while (Math.floor(Date.now() / 1000) === currentSecond) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function openChatFromList(page: Page, message: string): Promise<void> {
  const chatList = page.getByTestId('sidebar-chat-list')
  const listItemName = new RegExp(escapeRegExp(message))
  const allTab = page.getByTestId('sidebar-tab-all')
  const requestsTab = page.getByTestId('sidebar-tab-requests')
  const deadline = Date.now() + 30_000

  while (Date.now() < deadline) {
    for (const tabButton of [allTab, requestsTab]) {
      await tabButton.click().catch(() => {})
      const listItemByRole = chatList.getByRole('button', { name: listItemName }).first()
      const listItemByText = chatList.locator('button').filter({ hasText: message }).first()
      for (const listItem of [listItemByRole, listItemByText]) {
        if (await listItem.isVisible().catch(() => false)) {
          await listItem.scrollIntoViewIfNeeded().catch(() => {})
          await listItem.click()
          return
        }
      }
    }
    await page.waitForTimeout(250)
  }

  throw new Error(`Could not find chat list item for message preview: ${message}`)
}

async function registerDevice(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click()
  await page
    .getByRole('heading', { name: 'Devices' })
    .waitFor({ state: 'visible', timeout: 5000 })
    .catch(() => {})
  const registerButton = page.getByRole('button', { name: 'Register this device' })
  const thisDeviceLabel = page.getByText('This device').first()
  try {
    if (!(await registerButton.count())) {
      await Promise.race([
        registerButton.waitFor({ state: 'visible', timeout: 5000 }).catch(() => null),
        thisDeviceLabel.waitFor({ state: 'visible', timeout: 5000 }).catch(() => null),
      ])
    }
    if (await registerButton.count()) {
      await registerButton.click({ timeout: 5000 })
      await Promise.race([
        expect(registerButton).not.toBeVisible({ timeout: 20000 }).catch(() => null),
        thisDeviceLabel.waitFor({ state: 'visible', timeout: 20000 }).catch(() => null),
      ])
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    if (!message.includes('detached') && !message.includes('not stable')) {
      throw err
    }
  }
  await page.getByRole('button', { name: 'Back' }).click()
}

async function openLinkThisDevice(page: Page): Promise<void> {
  await page.goto('/')
  const linkButton = page.getByRole('button', { name: /link this device/i })
  if (!(await linkButton.isVisible().catch(() => false))) {
    await page.evaluate(() => {
      localStorage.removeItem('iris-chat-identity')
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
  }

  await expect(linkButton).toBeVisible({ timeout: 30000 })
  await linkButton.click()
  await expect(page.getByRole('heading', { name: 'Link this device' })).toBeVisible({
    timeout: 20000,
  })
}

async function getInviteUrl(page: Page): Promise<string> {
  const copyButton = page.locator('button[title*="#"]').first()
  await expect(copyButton).toBeVisible({ timeout: 30000 })
  const url = await copyButton.getAttribute('title')
  if (!url) throw new Error('Could not get invite URL')
  return url.replace('https://chat.iris.to', 'http://localhost:4173')
}

async function getLinkInviteUrl(page: Page): Promise<string> {
  const copyButton = page.locator('button[title*="#"]').first()
  await expect(copyButton).toBeVisible({ timeout: 30000 })
  const url = await copyButton.getAttribute('title')
  if (!url) throw new Error('Could not get link invite URL')
  return url
}

async function acceptLinkInvite(page: Page, inviteUrl: string): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Link another device' }).click()
  await waitForNextCreatedAtSecond()
  await page.getByPlaceholder('Paste link invite').fill(inviteUrl)
  await expect(page.getByText('Device linked')).toBeVisible({ timeout: 20000 })
  await page.locator('button[aria-label="Close"]').click()
  await page.getByRole('button', { name: 'Back' }).click()
}

function reapFlutterInteropAppProcesses(): void {
  if (process.platform !== 'darwin') {
    return
  }

  const result = spawnSync('pgrep', ['-f', FLUTTER_MACOS_APP_BINARY], {
    encoding: 'utf8',
  })
  const pids = result.stdout
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid)

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // best effort
    }
  }
}

type BridgeEvent =
  | { type: 'ready'; data?: { pubkeyHex?: string; relayUrl?: string; relayUrls?: string[] } }
  | { type: 'response'; id?: string; ok?: boolean; data?: unknown; error?: string }
  | { type: string; id?: string; ok?: boolean; data?: unknown; error?: string }

class FlutterInteropBridge {
  private bridgeDir: string | null = null
  private commandsFile: string | null = null
  private eventsFile: string | null = null
  private child: ChildProcessWithoutNullStreams | null = null
  private cmdSeq = 0
  private stdout = ''
  private stderr = ''

  constructor(
    private readonly relayUrls: string[],
    private readonly privateKeyNsec: string,
    private readonly registerDeviceOnLogin = false
  ) {}

  async start(): Promise<{ pubkeyHex: string }> {
    this.bridgeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'iris-flutter-interop-'))
    this.commandsFile = path.join(this.bridgeDir, 'commands.jsonl')
    this.eventsFile = path.join(this.bridgeDir, 'events.jsonl')
    reapFlutterInteropAppProcesses()

    this.child = spawn(
      'flutter',
      [
        'test',
        'integration_test/flutter_interop_bridge_macos_suite.dart',
        '-d',
        'macos',
        `--dart-define=IRIS_INTEROP_RELAY_URL=${this.relayUrls[0] ?? ''}`,
        `--dart-define=IRIS_INTEROP_RELAY_URLS=${this.relayUrls.join(',')}`,
        `--dart-define=IRIS_INTEROP_BRIDGE_DIR=${this.bridgeDir}`,
        `--dart-define=IRIS_INTEROP_PRIVATE_KEY_NSEC=${this.privateKeyNsec}`,
        `--dart-define=IRIS_INTEROP_REGISTER_DEVICE=${this.registerDeviceOnLogin ? '1' : '0'}`,
      ],
      {
        cwd: FLUTTER_REPO,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      }
    )

    this.child.stdout.on('data', (chunk) => {
      this.stdout += chunk.toString()
      if (this.stdout.length > 50000) this.stdout = this.stdout.slice(-50000)
    })
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString()
      if (this.stderr.length > 50000) this.stderr = this.stderr.slice(-50000)
    })

    const ready = await this.waitForEvent(
      (event) => event.type === 'ready' && typeof event.data?.pubkeyHex === 'string',
      120000
    )

    return { pubkeyHex: (ready.data?.pubkeyHex as string).toLowerCase() }
  }

  async stop(): Promise<void> {
    if (this.child) {
      try {
        await this.command('shutdown', {}, 5000)
      } catch {
        // best effort
      }
    }

    await this.waitForProcessExit(5000).catch(async () => {
      if (!this.child) return
      this.child.kill('SIGTERM')
      await this.waitForProcessExit(2000).catch(() => {
        if (!this.child || this.child.exitCode !== null) return
        this.child.kill('SIGKILL')
      })
    })
    reapFlutterInteropAppProcesses()

    if (this.bridgeDir) {
      await fsp.rm(this.bridgeDir, { recursive: true, force: true }).catch(() => {})
    }

    this.child = null
    this.bridgeDir = null
    this.commandsFile = null
    this.eventsFile = null
  }

  async command<T = Record<string, unknown>>(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs: number
  ): Promise<T> {
    if (!this.commandsFile) {
      throw new Error('Bridge not started: commands file missing')
    }

    const id = `cmd-${++this.cmdSeq}`
    const line = JSON.stringify({ id, type, payload }) + '\n'
    await fsp.appendFile(this.commandsFile, line)

    const response = await this.waitForEvent(
      (event) => event.type === 'response' && event.id === id,
      timeoutMs
    )

    if (!response.ok) {
      throw new Error(`Flutter bridge command failed (${type}): ${response.error}`)
    }

    return (response.data ?? {}) as T
  }

  private async waitForEvent(
    predicate: (event: BridgeEvent) => boolean,
    timeoutMs: number
  ): Promise<BridgeEvent> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      for (const event of await this.readEvents()) {
        if (predicate(event)) return event
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
      if (this.child && this.child.exitCode !== null) {
        throw new Error(
          `Flutter bridge exited early code=${this.child.exitCode}\nstdout:\n${this.stdout}\nstderr:\n${this.stderr}`
        )
      }
    }

    throw new Error(
      `Timed out waiting for Flutter bridge event after ${timeoutMs}ms\nstdout:\n${this.stdout}\nstderr:\n${this.stderr}`
    )
  }

  private async waitForProcessExit(timeoutMs: number): Promise<void> {
    if (!this.child) return
    if (this.child.exitCode !== null) return

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Timed out waiting for flutter process exit'))
      }, timeoutMs)

      const onExit = () => {
        cleanup()
        resolve()
      }

      const cleanup = () => {
        clearTimeout(timer)
        this.child?.off('exit', onExit)
      }

      this.child.on('exit', onExit)
    })
  }

  private async readEvents(): Promise<BridgeEvent[]> {
    if (!this.eventsFile || !fs.existsSync(this.eventsFile)) {
      return []
    }

    const content = await fsp.readFile(this.eventsFile, 'utf8')
    if (!content.trim()) return []

    const events: BridgeEvent[] = []
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        events.push(JSON.parse(trimmed) as BridgeEvent)
      } catch {
        // ignore malformed
      }
    }
    return events
  }
}

test('link device interop: flutter new device -> web owner accept', async ({
  browser,
  silentRelay,
  testRelayUrls,
}) => {
  test.skip(!RUN_FLUTTER_INTEROP, 'Set IRIS_FLUTTER_INTEROP=1 to run Flutter interop tests')
  test.skip(process.platform !== 'darwin', 'Requires macOS')
  test.skip(!fs.existsSync(FLUTTER_REPO), `Flutter repo missing: ${FLUTTER_REPO}`)
  test.setTimeout(300000)

  const ownerSecret = generateSecretKey()
  const ownerPrivkeyHex = toHex(ownerSecret)
  const ownerPubkeyHex = getPublicKey(ownerSecret).toLowerCase()

  const flutterSecret = generateSecretKey()
  const flutterNsec = nip19.nsecEncode(flutterSecret)

  const user2Secret = generateSecretKey()
  const user2PrivkeyHex = toHex(user2Secret)
  const user2PubkeyHex = getPublicKey(user2Secret).toLowerCase()

  const ownerContext = await browser.newContext()
  const user2Context = await browser.newContext()
  await useTestRelay(ownerContext, testRelayUrls)
  await useTestRelay(user2Context, testRelayUrls)
  await setIdentity(ownerContext, ownerPrivkeyHex)
  await setIdentity(user2Context, user2PrivkeyHex)

  const ownerPage = await ownerContext.newPage()
  const user2Page = await user2Context.newPage()
  const bridge = new FlutterInteropBridge(testRelayUrls, flutterNsec)

  try {
    await loginWithStoredKey(ownerPage)
    await loginWithStoredKey(user2Page)
    await registerDevice(ownerPage)

    await bridge.start()
    await bridge.command('wait_for_connected_relays', { minConnected: 1, timeoutMs: 30000 }, 40000)
    const silentRelayConnectionsReady = waitForRelayConnectionCount(silentRelay, 3, 120000)

    const created = await bridge.command<{ inviteUrl: string }>('create_link_invite', {}, 30000)
    await acceptLinkInvite(ownerPage, created.inviteUrl)

    const linked = await bridge.command<{ ownerPubkeyHex: string }>(
      'wait_for_linked_device',
      { timeoutMs: 40000 },
      50000
    )
    expect(linked.ownerPubkeyHex.toLowerCase()).toBe(ownerPubkeyHex)

    await user2Page.getByRole('button', { name: 'New Chat' }).click()
    const inviteUrl = await getInviteUrl(user2Page)

    await ownerPage.getByRole('button', { name: 'New Chat' }).click()
    await ownerPage.getByPlaceholder('Paste invite link').fill(inviteUrl)
    await expect(ownerPage.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 15000 })

    const ownerToUser2 = `owner->user2 via web ${Date.now()}`
    await ownerPage.getByPlaceholder('Type a message...').fill(ownerToUser2)
    await ownerPage.getByRole('button', { name: 'Send' }).click()

    const flutterSession = await bridge.command<{ sessionId: string }>(
      'wait_for_session',
      {
        recipientPubkeyHex: user2PubkeyHex,
        timeoutMs: 40000,
      },
      50000
    )
    await bridge.command(
      'wait_for_message',
      { text: ownerToUser2, timeoutMs: 40000, incomingOnly: false },
      50000
    )

    const flutterToUser2 = `owner->user2 via flutter linked ${Date.now()}`
    await bridge.command(
      'send_message_ui',
      { sessionId: flutterSession.sessionId, text: flutterToUser2 },
      30000
    )

    await openChatFromList(user2Page, flutterToUser2)
    await expect(
      user2Page.locator('.max-w-\\[85\\%\\]').filter({ hasText: flutterToUser2 }).first()
    ).toBeVisible({ timeout: 30000 })
    await silentRelayConnectionsReady
  } finally {
    await ownerContext.close()
    await user2Context.close()
    await bridge.stop()
  }
})

test('link device interop: linked flutter invite can be messaged by web user', async ({
  browser,
  silentRelay,
  testRelay,
  testRelayUrls,
}) => {
  test.skip(!RUN_FLUTTER_INTEROP, 'Set IRIS_FLUTTER_INTEROP=1 to run Flutter interop tests')
  test.skip(process.platform !== 'darwin', 'Requires macOS')
  test.skip(!fs.existsSync(FLUTTER_REPO), `Flutter repo missing: ${FLUTTER_REPO}`)
  test.setTimeout(300000)

  const ownerSecret = generateSecretKey()
  const ownerPrivkeyHex = toHex(ownerSecret)
  const ownerPubkeyHex = getPublicKey(ownerSecret).toLowerCase()

  const flutterSecret = generateSecretKey()
  const flutterNsec = nip19.nsecEncode(flutterSecret)

  const user2Secret = generateSecretKey()
  const user2PrivkeyHex = toHex(user2Secret)
  const user2PubkeyHex = getPublicKey(user2Secret).toLowerCase()

  const ownerContext = await browser.newContext()
  const user2Context = await browser.newContext()
  await useTestRelay(ownerContext, testRelayUrls)
  await useTestRelay(user2Context, testRelayUrls)
  await setIdentity(ownerContext, ownerPrivkeyHex)
  await setIdentity(user2Context, user2PrivkeyHex)

  const ownerPage = await ownerContext.newPage()
  const user2Page = await user2Context.newPage()
  const bridge = new FlutterInteropBridge(testRelayUrls, flutterNsec)

  try {
    await loginWithStoredKey(ownerPage)
    await loginWithStoredKey(user2Page)
    await registerDevice(ownerPage)
    await registerDevice(user2Page)

    await bridge.start()
    await bridge.command('wait_for_connected_relays', { minConnected: 1, timeoutMs: 30000 }, 40000)
    const silentRelayConnectionsReady = waitForRelayConnectionCount(silentRelay, 3, 120000)

    const linkInvite = await bridge.command<{ inviteUrl: string }>('create_link_invite', {}, 30000)
    await acceptLinkInvite(ownerPage, linkInvite.inviteUrl)

    const linked = await bridge.command<{ ownerPubkeyHex: string }>(
      'wait_for_linked_device',
      { timeoutMs: 40000 },
      50000
    )
    expect(linked.ownerPubkeyHex.toLowerCase()).toBe(ownerPubkeyHex)
    await waitForOwnerAppKeysEventCount(testRelay, ownerPubkeyHex, 2, 15000)

    const linkedInvite = await bridge.command<{ inviteUrl: string }>(
      'create_invite',
      { maxUses: 5 },
      30000
    )

    await user2Page.getByRole('button', { name: 'New Chat' }).click()
    await user2Page.getByPlaceholder('Paste invite link').fill(linkedInvite.inviteUrl)
    await expect(user2Page.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20000 })

    const flutterSession = await bridge.command<{ sessionId: string }>(
      'wait_for_session',
      {
        recipientPubkeyHex: user2PubkeyHex,
        timeoutMs: 40000,
      },
      50000
    )

    const user2ToLinkedFlutter = `user2->linked flutter invite ${Date.now()}`
    await user2Page.getByPlaceholder('Type a message...').fill(user2ToLinkedFlutter)
    await user2Page.getByRole('button', { name: 'Send' }).click()

    await openChatFromList(ownerPage, user2ToLinkedFlutter)
    await expect(
      ownerPage.locator('.max-w-\\[85\\%\\]').filter({ hasText: user2ToLinkedFlutter }).first()
    ).toBeVisible({ timeout: 30000 })
    expect(flutterSession.sessionId).toBeTruthy()
    await silentRelayConnectionsReady
  } finally {
    await ownerContext.close()
    await user2Context.close()
    await bridge.stop()
  }
})

test('link device interop: web new device -> flutter owner accept', async ({
  browser,
  silentRelay,
  testRelayUrls,
}) => {
  test.skip(!RUN_FLUTTER_INTEROP, 'Set IRIS_FLUTTER_INTEROP=1 to run Flutter interop tests')
  test.skip(process.platform !== 'darwin', 'Requires macOS')
  test.skip(!fs.existsSync(FLUTTER_REPO), `Flutter repo missing: ${FLUTTER_REPO}`)
  test.setTimeout(300000)

  const ownerSecret = generateSecretKey()
  const ownerNsec = nip19.nsecEncode(ownerSecret)
  const ownerPubkeyHex = getPublicKey(ownerSecret).toLowerCase()

  const user2Secret = generateSecretKey()
  const user2PrivkeyHex = toHex(user2Secret)

  const linkedContext = await browser.newContext()
  const user2Context = await browser.newContext()
  await useTestRelay(linkedContext, testRelayUrls)
  await useTestRelay(user2Context, testRelayUrls)
  await clearIdentity(linkedContext)
  await setIdentity(user2Context, user2PrivkeyHex)

  const linkedPage = await linkedContext.newPage()
  const user2Page = await user2Context.newPage()
  const bridge = new FlutterInteropBridge(testRelayUrls, ownerNsec, true)

  try {
    const ready = await bridge.start()
    expect(ready.pubkeyHex).toBe(ownerPubkeyHex)
    await bridge.command('wait_for_connected_relays', { minConnected: 1, timeoutMs: 30000 }, 40000)
    const silentRelayConnectionsReady = waitForRelayConnectionCount(silentRelay, 3, 120000)

    await loginWithStoredKey(user2Page)
    await registerDevice(user2Page)

    await openLinkThisDevice(linkedPage)
    const linkInviteUrl = await getLinkInviteUrl(linkedPage)

    await waitForNextCreatedAtSecond()
    await bridge.command('accept_link_invite', { inviteUrl: linkInviteUrl }, 30000)
    await expect(linkedPage.getByRole('button', { name: 'New Chat' })).toBeVisible({ timeout: 30000 })

    await user2Page.getByRole('button', { name: 'New Chat' }).click()
    const inviteUrl = await getInviteUrl(user2Page)

    await linkedPage.getByRole('button', { name: 'New Chat' }).click()
    await linkedPage.getByPlaceholder('Paste invite link').fill(inviteUrl)
    await expect(linkedPage.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20000 })

    const linkedToUser2 = `owner->user2 from web linked ${Date.now()}`
    await linkedPage.getByPlaceholder('Type a message...').fill(linkedToUser2)
    await linkedPage.getByRole('button', { name: 'Send' }).click()

    await openChatFromList(user2Page, linkedToUser2)
    await expect(
      user2Page.locator('.max-w-\\[85\\%\\]').filter({ hasText: linkedToUser2 }).first()
    ).toBeVisible({ timeout: 30000 })

    await bridge.command(
      'wait_for_message',
      { text: linkedToUser2, timeoutMs: 40000, incomingOnly: false },
      50000
    )
    await silentRelayConnectionsReady
  } finally {
    await linkedContext.close()
    await user2Context.close()
    await bridge.stop()
  }
})

test('link device interop: flutter owner keeps multiple web appkeys and sees web sender copies', async ({
  browser,
  silentRelay,
  testRelay,
  testRelayUrls,
}) => {
  test.skip(!RUN_FLUTTER_INTEROP, 'Set IRIS_FLUTTER_INTEROP=1 to run Flutter interop tests')
  test.skip(process.platform !== 'darwin', 'Requires macOS')
  test.skip(!fs.existsSync(FLUTTER_REPO), `Flutter repo missing: ${FLUTTER_REPO}`)
  test.setTimeout(360000)

  const ownerSecret = generateSecretKey()
  const ownerNsec = nip19.nsecEncode(ownerSecret)
  const ownerPubkeyHex = getPublicKey(ownerSecret).toLowerCase()

  const user2Secret = generateSecretKey()
  const user2PrivkeyHex = toHex(user2Secret)

  const linkedContext1 = await browser.newContext()
  const linkedContext2 = await browser.newContext()
  const user2Context = await browser.newContext()
  await useTestRelay(linkedContext1, testRelayUrls)
  await useTestRelay(linkedContext2, testRelayUrls)
  await useTestRelay(user2Context, testRelayUrls)
  await clearIdentity(linkedContext1)
  await clearIdentity(linkedContext2)
  await setIdentity(user2Context, user2PrivkeyHex)

  const linkedPage1 = await linkedContext1.newPage()
  const linkedPage2 = await linkedContext2.newPage()
  const user2Page = await user2Context.newPage()
  const bridge = new FlutterInteropBridge(testRelayUrls, ownerNsec, true)

  try {
    const ready = await bridge.start()
    expect(ready.pubkeyHex).toBe(ownerPubkeyHex)
    await bridge.command('wait_for_connected_relays', { minConnected: 1, timeoutMs: 30000 }, 40000)
    const silentRelayConnectionsReady = waitForRelayConnectionCount(silentRelay, 4, 180000)

    await loginWithStoredKey(user2Page)
    await registerDevice(user2Page)

    await openLinkThisDevice(linkedPage1)
    const linkInviteUrl1 = await getLinkInviteUrl(linkedPage1)
    await waitForNextCreatedAtSecond()
    await bridge.command('accept_link_invite', { inviteUrl: linkInviteUrl1 }, 30000)
    await expect(linkedPage1.getByRole('button', { name: 'New Chat' })).toBeVisible({
      timeout: 30000,
    })
    await waitForOwnerAppKeysEventCount(testRelay, ownerPubkeyHex, 2, 15000)

    await openLinkThisDevice(linkedPage2)
    const linkInviteUrl2 = await getLinkInviteUrl(linkedPage2)
    await waitForNextCreatedAtSecond()
    await bridge.command('accept_link_invite', { inviteUrl: linkInviteUrl2 }, 30000)
    await expect(linkedPage2.getByRole('button', { name: 'New Chat' })).toBeVisible({
      timeout: 30000,
    })

    const latestAppKeys = await waitForLatestOwnerAppKeysDeviceCount(
      testRelay,
      ownerPubkeyHex,
      3,
      20000
    )
    expect(latestAppKeys?.tags.filter((tag) => tag[0] === 'device')).toHaveLength(3)

    await user2Page.getByRole('button', { name: 'New Chat' }).click()
    const inviteUrl = await getInviteUrl(user2Page)

    await linkedPage1.getByRole('button', { name: 'New Chat' }).click()
    await linkedPage1.getByPlaceholder('Paste invite link').fill(inviteUrl)
    await expect(linkedPage1.getByPlaceholder('Type a message...')).toBeVisible({
      timeout: 20000,
    })

    const linkedWebToUser2 = `owner->user2 from linked web 1 ${Date.now()}`
    await linkedPage1.getByPlaceholder('Type a message...').fill(linkedWebToUser2)
    await linkedPage1.getByRole('button', { name: 'Send' }).click()

    await openChatFromList(user2Page, linkedWebToUser2)
    await expect(
      user2Page.locator('.max-w-\\[85\\%\\]').filter({ hasText: linkedWebToUser2 }).first()
    ).toBeVisible({ timeout: 30000 })

    await bridge.command(
      'wait_for_message',
      { text: linkedWebToUser2, timeoutMs: 40000, incomingOnly: false },
      50000
    )
    await silentRelayConnectionsReady
  } finally {
    await linkedContext1.close()
    await linkedContext2.close()
    await user2Context.close()
    await bridge.stop()
  }
})

test('link device interop: linked web sender reaches linked flutter receiver across four devices', async ({
  browser,
  silentRelay,
  testRelay,
  testRelayUrls,
}) => {
  test.skip(!RUN_FLUTTER_INTEROP, 'Set IRIS_FLUTTER_INTEROP=1 to run Flutter interop tests')
  test.skip(process.platform !== 'darwin', 'Requires macOS')
  test.skip(!fs.existsSync(FLUTTER_REPO), `Flutter repo missing: ${FLUTTER_REPO}`)
  test.setTimeout(420000)

  const aliceOwnerSecret = generateSecretKey()
  const aliceOwnerPrivkeyHex = toHex(aliceOwnerSecret)
  const aliceOwnerPubkeyHex = getPublicKey(aliceOwnerSecret).toLowerCase()

  const aliceFlutterSecret = generateSecretKey()
  const aliceFlutterNsec = nip19.nsecEncode(aliceFlutterSecret)

  const bobOwnerSecret = generateSecretKey()
  const bobOwnerPrivkeyHex = toHex(bobOwnerSecret)
  const bobOwnerPubkeyHex = getPublicKey(bobOwnerSecret).toLowerCase()

  const aliceOwnerContext = await browser.newContext()
  const bobOwnerContext = await browser.newContext()
  const bobLinkedContext = await browser.newContext()
  await useTestRelay(aliceOwnerContext, testRelayUrls)
  await useTestRelay(bobOwnerContext, testRelayUrls)
  await useTestRelay(bobLinkedContext, testRelayUrls)
  await setIdentity(aliceOwnerContext, aliceOwnerPrivkeyHex)
  await setIdentity(bobOwnerContext, bobOwnerPrivkeyHex)
  await clearIdentity(bobLinkedContext)

  const aliceOwnerPage = await aliceOwnerContext.newPage()
  const bobOwnerPage = await bobOwnerContext.newPage()
  const bobLinkedPage = await bobLinkedContext.newPage()
  const bridge = new FlutterInteropBridge(testRelayUrls, aliceFlutterNsec)

  try {
    await loginWithStoredKey(aliceOwnerPage)
    await loginWithStoredKey(bobOwnerPage)
    await registerDevice(aliceOwnerPage)
    await registerDevice(bobOwnerPage)

    const ready = await bridge.start()
    expect(ready.pubkeyHex).not.toBe(aliceOwnerPubkeyHex)
    await bridge.command('wait_for_connected_relays', { minConnected: 1, timeoutMs: 30000 }, 40000)
    const silentRelayConnectionsReady = waitForRelayConnectionCount(silentRelay, 4, 180000)

    const aliceLinkInvite = await bridge.command<{ inviteUrl: string }>('create_link_invite', {}, 30000)
    await acceptLinkInvite(aliceOwnerPage, aliceLinkInvite.inviteUrl)

    const linkedFlutter = await bridge.command<{ ownerPubkeyHex: string }>(
      'wait_for_linked_device',
      { timeoutMs: 40000 },
      50000
    )
    expect(linkedFlutter.ownerPubkeyHex.toLowerCase()).toBe(aliceOwnerPubkeyHex)
    await waitForOwnerAppKeysEventCount(testRelay, aliceOwnerPubkeyHex, 2, 15000)

    await openLinkThisDevice(bobLinkedPage)
    const bobLinkInviteUrl = await getLinkInviteUrl(bobLinkedPage)
    await acceptLinkInvite(bobOwnerPage, bobLinkInviteUrl)
    await expect(bobLinkedPage.getByRole('button', { name: 'New Chat' })).toBeVisible({
      timeout: 30000,
    })
    await waitForLatestOwnerAppKeysDeviceCount(testRelay, bobOwnerPubkeyHex, 2, 15000)

    await bobOwnerPage.getByRole('button', { name: 'New Chat' }).click()
    const bobInviteUrl = await getInviteUrl(bobOwnerPage)

    await aliceOwnerPage.getByRole('button', { name: 'New Chat' }).click()
    await aliceOwnerPage.getByPlaceholder('Paste invite link').fill(bobInviteUrl)
    await expect(aliceOwnerPage.getByPlaceholder('Type a message...')).toBeVisible({
      timeout: 20000,
    })

    const aliceBootstrap = `alice owner -> bob bootstrap ${Date.now()}`
    await aliceOwnerPage.getByPlaceholder('Type a message...').fill(aliceBootstrap)
    await aliceOwnerPage.getByRole('button', { name: 'Send' }).click()

    await openChatFromList(bobLinkedPage, aliceBootstrap)
    await expect(
      bobLinkedPage.locator('.max-w-\\[85\\%\\]').filter({ hasText: aliceBootstrap }).first()
    ).toBeVisible({ timeout: 30000 })

    await bridge.command(
      'wait_for_session',
      {
        recipientPubkeyHex: bobOwnerPubkeyHex,
        timeoutMs: 40000,
      },
      50000
    )
    await bridge.command(
      'wait_for_message',
      { text: aliceBootstrap, timeoutMs: 40000, incomingOnly: false },
      50000
    )

    const bobLinkedToAlice = `bob linked -> alice flutter ${Date.now()}`
    await bobLinkedPage.getByPlaceholder('Type a message...').fill(bobLinkedToAlice)
    await bobLinkedPage.getByRole('button', { name: 'Send' }).click()

    await openChatFromList(aliceOwnerPage, bobLinkedToAlice)
    await expect(
      aliceOwnerPage.locator('.max-w-\\[85\\%\\]').filter({ hasText: bobLinkedToAlice }).first()
    ).toBeVisible({ timeout: 30000 })

    try {
      await bridge.command(
        'wait_for_message',
        { text: bobLinkedToAlice, timeoutMs: 40000, incomingOnly: true },
        50000
      )
    } catch (error) {
      const debugState = await bridge.command<Record<string, unknown>>('get_debug_state', {}, 15000)
      const message = error instanceof Error ? error.message : String(error)
      const relayMessages = testRelay.publishedEvents
        .filter((event) => event.kind === 1060)
        .slice(-12)
        .map((event) => ({
          id: event.id,
          pubkey: event.pubkey,
          tags: event.tags,
          created_at: event.created_at,
        }))
      throw new Error(
        `${message}\nFlutter debug state:\n${JSON.stringify(debugState, null, 2)}\n` +
          `Recent relay 1060 events:\n${JSON.stringify(relayMessages, null, 2)}`
      )
    }
    await silentRelayConnectionsReady
  } finally {
    await aliceOwnerContext.close()
    await bobOwnerContext.close()
    await bobLinkedContext.close()
    await bridge.stop()
  }
})

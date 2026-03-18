import { test, expect, useTestRelay } from './fixtures'
import type { BrowserContext, Page } from '@playwright/test'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const RUN_FLUTTER_INTEROP = process.env.IRIS_FLUTTER_INTEROP === '1'
const FLUTTER_REPO = path.resolve(__dirname, '../../iris-chat-flutter')
const IRIS_CLIENT_REPO = path.resolve(__dirname, '../../iris-client')
const FLUTTER_MACOS_APP_BINARY = path.join(
  FLUTTER_REPO,
  'build/macos/Build/Products/Debug/iris chat.app/Contents/MacOS/iris chat'
)

test.describe.configure({ mode: 'serial' })

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim()
  if (normalized.length % 2 !== 0) {
    throw new Error(`Invalid hex string length: ${normalized.length}`)
  }

  const out = new Uint8Array(normalized.length / 2)
  for (let i = 0; i < normalized.length; i += 2) {
    out[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16)
  }
  return out
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

async function loginAnonymously(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Go' }).click()
  await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible({
    timeout: 30000,
  })
}

async function getStoredIdentityPrivkeyHex(page: Page): Promise<string> {
  const privkeyHex = await page.evaluate(() => localStorage.getItem('iris-chat-identity'))
  if (!privkeyHex) {
    throw new Error('No stored web identity found in localStorage')
  }
  return privkeyHex
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function openChatFromList(page: Page, previewText: string): Promise<void> {
  const chatList = page.getByTestId('sidebar-chat-list')
  const listItemName = new RegExp(escapeRegExp(previewText))
  const allTab = page.getByTestId('sidebar-tab-all')
  const requestsTab = page.getByTestId('sidebar-tab-requests')
  const deadline = Date.now() + 30_000

  while (Date.now() < deadline) {
    for (const tabButton of [allTab, requestsTab]) {
      await tabButton.click().catch(() => {})
      const listItemByRole = chatList.getByRole('button', { name: listItemName }).first()
      const listItemByText = chatList.locator('button').filter({ hasText: previewText }).first()
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

  throw new Error(`Could not find chat list item for message preview: ${previewText}`)
}

async function openGroupFromSidebar(page: Page, groupName: string): Promise<void> {
  const chatList = page.getByTestId('sidebar-chat-list')
  const allTab = page.getByTestId('sidebar-tab-all')
  const requestsTab = page.getByTestId('sidebar-tab-requests')
  const deadline = Date.now() + 60_000

  while (Date.now() < deadline) {
    for (const tabButton of [allTab, requestsTab]) {
      await tabButton.click().catch(() => {})
      const groupListItem = chatList
        .getByRole('button', { name: new RegExp(groupName) })
        .first()
      if (await groupListItem.isVisible().catch(() => false)) {
        await groupListItem.click()
        return
      }
    }

    await page.waitForTimeout(250)
  }

  throw new Error(`Could not find group list item: ${groupName}`)
}

async function acceptOpenGroupIfNeeded(page: Page): Promise<void> {
  const acceptButton = page.getByRole('button', { name: 'Accept' })
  if (await acceptButton.isVisible().catch(() => false)) {
    await acceptButton.click()
  }
}

async function expectChatMessageVisible(page: Page, text: string): Promise<void> {
  const visibleText = page.getByText(text, { exact: true }).first()
  try {
    await expect(visibleText).toBeVisible({ timeout: 5000 })
    return
  } catch {
    await openChatFromList(page, text).catch(() => {})
  }
  await expect(visibleText).toBeVisible({ timeout: 90_000 })
}

async function expectIrisClientMessageVisible(page: Page, text: string): Promise<void> {
  await expect(page.locator('.whitespace-pre-wrap').getByText(text).last()).toBeVisible({
    timeout: 60_000,
  })
}

async function sendWebMessages(page: Page, texts: string[]): Promise<void> {
  const input = page.getByPlaceholder('Type a message...')
  for (const text of texts) {
    await input.fill(text)
    await page.getByRole('button', { name: 'Send' }).click()
  }
}

async function sendIrisClientMessages(page: Page, texts: string[]): Promise<void> {
  const input = page.getByPlaceholder('Message').last()
  for (const text of texts) {
    await input.fill(text)
    await input.press('Enter')
    await expectIrisClientMessageVisible(page, text)
  }
}

async function sendFlutterMessages(
  bridge: FlutterInteropBridge,
  sessionId: string,
  texts: string[]
): Promise<void> {
  for (const text of texts) {
    await bridge.command(
      'send_message_ui',
      {
        sessionId,
        text,
      },
      30000
    )
  }
}

async function expectFlutterMessages(
  bridge: FlutterInteropBridge,
  texts: string[],
  incomingOnly = false
): Promise<void> {
  for (const text of texts) {
    await bridge.command(
      'wait_for_message_meta',
      {
        text,
        timeoutMs: 40000,
        incomingOnly,
      },
      50000
    )
  }
}

async function waitForNextCreatedAtSecond(): Promise<void> {
  const currentSecond = Math.floor(Date.now() / 1000)
  while (Math.floor(Date.now() / 1000) === currentSecond) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
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

async function getLinkInviteUrl(page: Page): Promise<string> {
  const copyButton = page.locator('button[title*="#"]').first()
  await expect(copyButton).toBeVisible({ timeout: 10000 })
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

async function getAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not determine free port')))
        return
      }
      const { port } = address
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

async function waitForHttpReady(url: string, timeoutMs: number, onTimeout: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // wait for server startup
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`Timed out waiting for ${url}\n${onTimeout()}`)
}

async function seedIrisClientRelay(context: BrowserContext, relayUrlOrUrls: string | string[]) {
  const relayUrls = Array.isArray(relayUrlOrUrls) ? relayUrlOrUrls : [relayUrlOrUrls]

  await context.addInitScript((urls: string[]) => {
    try {
      const raw = window.localStorage.getItem('user-storage')
      const parsed =
        raw && raw.trim().length > 0
          ? (JSON.parse(raw) as { state?: Record<string, unknown>; version?: number })
          : {}
      const state = parsed.state ?? {}
      window.localStorage.setItem(
        'user-storage',
        JSON.stringify({
          version: typeof parsed.version === 'number' ? parsed.version : 2,
          state: {
            ...state,
            relays: urls,
            relayConfigs: urls.map((url) => ({ url })),
            ndkOutboxModel: false,
            autoConnectUserRelays: false,
          },
        })
      )
    } catch {
      // ignore opaque origins (about:blank)
    }
  }, relayUrls)
}

async function loginIrisClientWithKey(page: Page, baseUrl: string, privateKeyNsec: string): Promise<void> {
  await page.goto(baseUrl)
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('#main-content')).toBeVisible({ timeout: 10000 })

  const signUpHeading = page.getByRole('heading', { name: 'Sign up' })
  const signInHeading = page.getByRole('heading', { name: 'Sign in' })

  if (
    !(await signUpHeading.isVisible().catch(() => false)) &&
    !(await signInHeading.isVisible().catch(() => false))
  ) {
    const signUpButton = page.locator('button:visible', { hasText: 'Sign up' }).first()
    await expect(signUpButton).toBeVisible({ timeout: 10000 })
    await signUpButton.click()
  }

  if (await signUpHeading.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Sign in' }).click()
  }

  await expect(signInHeading).toBeVisible({ timeout: 10000 })
  await page.getByPlaceholder(/paste secret or public key/i).fill(privateKeyNsec)
  await expect(signInHeading).not.toBeVisible({ timeout: 15000 })
  await expect(page.locator('#main-content').getByTestId('new-post-button')).toBeVisible({
    timeout: 15000,
  })
}

async function waitForIrisClientRelays(page: Page): Promise<void> {
  const relayIndicator = page.locator('[title*="relays connected"]').first()
  await expect(relayIndicator).toBeVisible({ timeout: 10000 })
  await expect
    .poll(
      async () => {
        const text = await relayIndicator.textContent()
        return Number.parseInt(text?.match(/\d+/)?.[0] || '0', 10)
      },
      { timeout: 10000 }
    )
    .toBeGreaterThan(0)
}

async function ensureIrisClientCurrentDeviceRegistered(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/chats/new/devices`)
  await expect(page.getByRole('button', { name: 'Link another device' })).toBeVisible({
    timeout: 10000,
  })

  const registerButton = page.getByRole('button', { name: 'Register this device' })
  const thisDeviceBadge = page.locator('span.badge').filter({ hasText: /^This device$/ })

  if (!(await thisDeviceBadge.isVisible().catch(() => false))) {
    if (await registerButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await Promise.race([
        thisDeviceBadge.waitFor({ state: 'visible', timeout: 3000 }),
        registerButton.waitFor({ state: 'hidden', timeout: 3000 }),
      ]).catch(() => {})

      if (
        !(await thisDeviceBadge.isVisible().catch(() => false)) &&
        (await registerButton.isVisible().catch(() => false))
      ) {
        await registerButton.click({ timeout: 10000 })

        const confirmDialog = page
          .locator('dialog[open]')
          .filter({ has: page.getByRole('heading', { name: 'Confirm Device Registration' }) })

        await Promise.race([
          thisDeviceBadge.waitFor({ state: 'visible', timeout: 5000 }),
          confirmDialog.waitFor({ state: 'visible', timeout: 5000 }),
        ]).catch(() => {})

        if (await confirmDialog.isVisible().catch(() => false)) {
          await confirmDialog
            .getByRole('button', { name: 'Register Device' })
            .click({ timeout: 10000, force: true })
        }
      }
    }
  }

  await expect(thisDeviceBadge).toBeVisible({ timeout: 20000 })
}

async function openIrisClientSelfChat(page: Page): Promise<void> {
  const profileLink = page.locator('[data-testid="sidebar-user-row"]').first()
  await profileLink.click()
  await page.waitForLoadState('domcontentloaded')

  await expect(page.getByTestId('profile-header-actions')).toBeVisible({
    timeout: 10000,
  })

  const messageButton = page
    .getByTestId('profile-header-actions')
    .locator('button')
    .filter({ has: page.locator('use[href*="mail-outline"]') })
    .first()
  await expect(messageButton).toBeVisible({ timeout: 15000 })
  await messageButton.click()
  await expect(page).toHaveURL(/\/chats\/chat/, { timeout: 15000 })

  const messageInput = page.getByPlaceholder('Message').last()
  await expect(messageInput).toBeVisible({ timeout: 30000 })
  await expect(messageInput).toBeEnabled({ timeout: 60000 })
}

async function openIrisClientChatFromList(page: Page, previewText: string): Promise<void> {
  const deadline = Date.now() + 60_000
  const previewPattern = new RegExp(escapeRegExp(previewText))

  const chatsLink = page.getByRole('link', { name: 'Chats' })
  if (await chatsLink.isVisible().catch(() => false)) {
    await chatsLink.click().catch(() => {})
  }

  while (Date.now() < deadline) {
    const candidateLists = [
      page.locator('a[href="/chats/chat"]').filter({ hasText: previewText }),
      page.locator('a[href="/chats/chat"]').filter({ hasText: previewPattern }),
      page.locator('#main-content').getByText(previewText, { exact: false }),
    ]

    for (const candidates of candidateLists) {
      const count = await candidates.count().catch(() => 0)
      for (let index = 0; index < count; index += 1) {
        const chatLink = candidates.nth(index)
        if (await chatLink.isVisible().catch(() => false)) {
          await chatLink.click()
          await expect(page).toHaveURL(/\/chats\/chat/, { timeout: 15000 })
          await expect(page.getByPlaceholder('Message').last()).toBeVisible({ timeout: 30000 })
          return
        }
      }
    }

    await page.waitForTimeout(250)
  }

  throw new Error(`Could not find iris-client chat preview: ${previewText}`)
}

class IrisClientServer {
  private child: ChildProcessWithoutNullStreams | null = null
  private stdout = ''
  private stderr = ''

  constructor(private readonly port: number) {}

  async start(): Promise<string> {
    const baseUrl = `http://127.0.0.1:${this.port}`

    this.child = spawn(
      'pnpm',
      ['exec', 'vite', '--host', '127.0.0.1', '--port', String(this.port), '--strictPort'],
      {
        cwd: IRIS_CLIENT_REPO,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          VITE_E2E: 'true',
        },
      }
    )

    this.child.stdout.on('data', (chunk) => {
      this.stdout += chunk.toString()
      if (this.stdout.length > 50000) {
        this.stdout = this.stdout.slice(-50000)
      }
    })
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString()
      if (this.stderr.length > 50000) {
        this.stderr = this.stderr.slice(-50000)
      }
    })

    await waitForHttpReady(baseUrl, 60000, () => `stdout:\n${this.stdout}\nstderr:\n${this.stderr}`)
    return baseUrl
  }

  async stop(): Promise<void> {
    if (!this.child) return
    if (this.child.exitCode === null) {
      this.child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.child?.kill('SIGKILL')
          resolve()
        }, 5000)
        this.child?.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    this.child = null
  }
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
  | {
      type: 'ready'
      data?: {
        pubkeyHex?: string
        devicePubkeyHex?: string
        relayUrl?: string
        relayUrls?: string[]
      }
    }
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
    private readonly registerDeviceOnLogin = false,
    private readonly dataDir?: string
  ) {}

  async start(): Promise<{ pubkeyHex: string; devicePubkeyHex?: string }> {
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
        ...(this.dataDir ? [`--dart-define=IRIS_INTEROP_DATA_DIR=${this.dataDir}`] : []),
      ],
      {
        cwd: FLUTTER_REPO,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      }
    )

    this.child.stdout.on('data', (chunk) => {
      this.stdout += chunk.toString()
      if (this.stdout.length > 50000) {
        this.stdout = this.stdout.slice(-50000)
      }
    })
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString()
      if (this.stderr.length > 50000) {
        this.stderr = this.stderr.slice(-50000)
      }
    })

    const ready = await this.waitForEvent(
      (event) => event.type === 'ready' && typeof event.data?.pubkeyHex === 'string',
      120000
    )

    return {
      pubkeyHex: (ready.data?.pubkeyHex as string).toLowerCase(),
      devicePubkeyHex:
        typeof ready.data?.devicePubkeyHex === 'string'
          ? ready.data.devicePubkeyHex.toLowerCase()
          : undefined,
    }
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

test('self-chat interop (same key) between web and flutter', async ({
  browser,
  silentRelay,
  testRelayUrls,
}) => {
  test.skip(!RUN_FLUTTER_INTEROP, 'Set IRIS_FLUTTER_INTEROP=1 to run Flutter interop tests')
  test.skip(process.platform !== 'darwin', 'Requires macOS')
  test.skip(!fs.existsSync(FLUTTER_REPO), `Flutter repo missing: ${FLUTTER_REPO}`)
  test.setTimeout(240000)

  const secretKey = generateSecretKey()
  const privkeyHex = toHex(secretKey)
  const privateKeyNsec = nip19.nsecEncode(secretKey)
  const expectedPubkeyHex = getPublicKey(secretKey).toLowerCase()

  const context = await browser.newContext()
  await useTestRelay(context, testRelayUrls)
  await setIdentity(context, privkeyHex)
  const page = await context.newPage()

  const bridge = new FlutterInteropBridge(testRelayUrls, privateKeyNsec, true)

  try {
    const ready = await bridge.start()
    expect(ready.pubkeyHex).toBe(expectedPubkeyHex)
    const silentRelayConnectionsReady = waitForRelayConnectionCount(silentRelay, 2, 120000)
    await waitForNextCreatedAtSecond()

    await loginWithStoredKey(page)

    const created = await bridge.command<{ inviteUrl: string }>(
      'create_invite',
      { maxUses: 5 },
      30000
    )

    await page.getByRole('button', { name: 'New Chat' }).click()
    await page.getByPlaceholder('Paste invite link').fill(created.inviteUrl)
    await expect(page.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20000 })

    const webMessage = 'web->flutter self interop'
    await page.getByPlaceholder('Type a message...').fill(webMessage)
    await page.getByRole('button', { name: 'Send' }).click()
    const flutterIncomingMessage = await bridge.command<{ sessionId: string }>(
      'wait_for_message_meta',
      {
        text: webMessage,
        timeoutMs: 30000,
      },
      40000
    )

    const flutterMessage = 'flutter->web self interop'
    await bridge.command(
      'send_message_ui',
      {
        sessionId: flutterIncomingMessage.sessionId,
        text: flutterMessage,
      },
      30000
    )

    await expectChatMessageVisible(page, flutterMessage)
    await silentRelayConnectionsReady
  } finally {
    await context.close()
    await bridge.stop()
  }
})

test('direct self-chat interop (same key) between web and flutter', async ({
  browser,
  silentRelay,
  testRelayUrls,
}) => {
  test.skip(!RUN_FLUTTER_INTEROP, 'Set IRIS_FLUTTER_INTEROP=1 to run Flutter interop tests')
  test.skip(process.platform !== 'darwin', 'Requires macOS')
  test.skip(!fs.existsSync(FLUTTER_REPO), `Flutter repo missing: ${FLUTTER_REPO}`)
  test.setTimeout(240000)

  const secretKey = generateSecretKey()
  const privkeyHex = toHex(secretKey)
  const privateKeyNsec = nip19.nsecEncode(secretKey)
  const expectedPubkeyHex = getPublicKey(secretKey).toLowerCase()
  const expectedNpub = nip19.npubEncode(expectedPubkeyHex)

  const context = await browser.newContext()
  await useTestRelay(context, testRelayUrls)
  await setIdentity(context, privkeyHex)
  const page = await context.newPage()

  const bridge = new FlutterInteropBridge(testRelayUrls, privateKeyNsec, true)

  try {
    const ready = await bridge.start()
    expect(ready.pubkeyHex).toBe(expectedPubkeyHex)
    const silentRelayConnectionsReady = waitForRelayConnectionCount(silentRelay, 2, 120000)
    await waitForNextCreatedAtSecond()

    await loginWithStoredKey(page)

    await page.getByRole('button', { name: 'New Chat' }).click()
    await page.getByPlaceholder('Paste invite link').fill(`https://chat.iris.to/#${expectedNpub}`)
    await expect(page.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20000 })

    const webMessage = `web->flutter direct self interop ${Date.now()}`
    await page.getByPlaceholder('Type a message...').fill(webMessage)
    await page.getByRole('button', { name: 'Send' }).click()
    let flutterSelfSession: { sessionId: string }
    try {
      flutterSelfSession = await bridge.command<{ sessionId: string }>(
        'wait_for_message_meta',
        {
          text: webMessage,
          timeoutMs: 30000,
        },
        40000
      )
    } catch (error) {
      const debugState = await bridge.command<Record<string, unknown>>('get_debug_state', {}, 10000)
      console.log('[direct-self debug state]', JSON.stringify(debugState, null, 2))
      throw error
    }

    const flutterMessage = `flutter->web direct self interop ${Date.now()}`
    await bridge.command(
      'send_message_ui',
      {
        sessionId: flutterSelfSession.sessionId,
        text: flutterMessage,
      },
      30000
    )

    await expectChatMessageVisible(page, flutterMessage)
    await silentRelayConnectionsReady
  } finally {
    await context.close()
    await bridge.stop()
  }
})

test('direct self-chat interop (same key) from flutter first between web and flutter', async ({
  browser,
  silentRelay,
  testRelay,
  testRelayUrls,
}) => {
  test.skip(!RUN_FLUTTER_INTEROP, 'Set IRIS_FLUTTER_INTEROP=1 to run Flutter interop tests')
  test.skip(process.platform !== 'darwin', 'Requires macOS')
  test.skip(!fs.existsSync(FLUTTER_REPO), `Flutter repo missing: ${FLUTTER_REPO}`)
  test.setTimeout(240000)

  const secretKey = generateSecretKey()
  const privkeyHex = toHex(secretKey)
  const privateKeyNsec = nip19.nsecEncode(secretKey)
  const expectedPubkeyHex = getPublicKey(secretKey).toLowerCase()
  const expectedNpub = nip19.npubEncode(expectedPubkeyHex)

  const context = await browser.newContext()
  await useTestRelay(context, testRelayUrls)
  await setIdentity(context, privkeyHex)
  const page = await context.newPage()

  const bridge = new FlutterInteropBridge(testRelayUrls, privateKeyNsec, true)

  try {
    const ready = await bridge.start()
    expect(ready.pubkeyHex).toBe(expectedPubkeyHex)
    expect(ready.devicePubkeyHex).toBeTruthy()
    const silentRelayConnectionsReady = waitForRelayConnectionCount(silentRelay, 2, 120000)
    await waitForNextCreatedAtSecond()

    await loginWithStoredKey(page)

    const latestAppKeys = await waitForLatestOwnerAppKeysDeviceCount(
      testRelay,
      expectedPubkeyHex,
      2,
      15000
    )
    const registeredDevicePubkeys = latestAppKeys.tags
      .filter((tag) => tag[0] === 'device' && tag[1]?.trim().length > 0)
      .map((tag) => tag[1].toLowerCase())
    expect(registeredDevicePubkeys).toContain(ready.devicePubkeyHex as string)
    const webDevicePubkeyHex = registeredDevicePubkeys.find(
      (pubkey) => pubkey !== ready.devicePubkeyHex
    )
    expect(webDevicePubkeyHex).toBeTruthy()

    await page.getByRole('button', { name: 'New Chat' }).click()
    await page.getByPlaceholder('Paste invite link').fill(`https://chat.iris.to/#${expectedNpub}`)
    await expect(page.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20000 })
    await waitForLatestOwnerAppKeysDeviceCount(testRelay, expectedPubkeyHex, 2, 15000)
    await expect
      .poll(
        () =>
          testRelay.publishedEvents.filter((event) => {
            if (event.kind !== 30078 || event.pubkey !== webDevicePubkeyHex) return false
            const hasInviteLabel = event.tags.some(
              (tag) => tag[0] === 'l' && tag[1] === 'double-ratchet/invites'
            )
            const hasInviteId = event.tags.some(
              (tag) => tag[0] === 'd' && tag[1] === `double-ratchet/invites/${webDevicePubkeyHex}`
            )
            return hasInviteLabel && hasInviteId
          }).length,
        { timeout: 15000 }
      )
      .toBeGreaterThan(0)

    const flutterSelfSession = await bridge.command<{
      sessionId: string
      acceptedViaPublicInvite: boolean
    }>(
      'ensure_session_for_recipient',
      {
        recipientPubkeyHex: expectedPubkeyHex,
      },
      30000
    )
    expect(flutterSelfSession.acceptedViaPublicInvite).toBe(true)

    const flutterMessage = `flutter->web direct self first ${Date.now()}`
    await bridge.command(
      'send_message_ui',
      {
        sessionId: flutterSelfSession.sessionId,
        text: flutterMessage,
      },
      30000
    )
    await expectChatMessageVisible(page, flutterMessage)

    const webMessage = `web->flutter direct self second ${Date.now()}`
    await page.getByPlaceholder('Type a message...').fill(webMessage)
    await page.getByRole('button', { name: 'Send' }).click()
    await bridge.command(
      'wait_for_message_meta',
      {
        text: webMessage,
        timeoutMs: 30000,
      },
      40000
    )
    await silentRelayConnectionsReady
  } finally {
    await context.close()
    await bridge.stop()
  }
})

test('self-chat interop (same key) across web, flutter, and iris-client', async ({
  browser,
  silentRelay,
  testRelay,
  testRelayUrls,
}) => {
  test.skip(!RUN_FLUTTER_INTEROP, 'Set IRIS_FLUTTER_INTEROP=1 to run Flutter interop tests')
  test.skip(process.platform !== 'darwin', 'Requires macOS')
  test.skip(!fs.existsSync(FLUTTER_REPO), `Flutter repo missing: ${FLUTTER_REPO}`)
  test.skip(!fs.existsSync(IRIS_CLIENT_REPO), `Iris client repo missing: ${IRIS_CLIENT_REPO}`)
  test.setTimeout(300000)

  const secretKey = generateSecretKey()
  const privkeyHex = toHex(secretKey)
  const privateKeyNsec = nip19.nsecEncode(secretKey)
  const expectedPubkeyHex = getPublicKey(secretKey).toLowerCase()
  const expectedNpub = nip19.npubEncode(expectedPubkeyHex)

  const webContext = await browser.newContext()
  await useTestRelay(webContext, testRelayUrls)
  await setIdentity(webContext, privkeyHex)
  const webPage = await webContext.newPage()

  const flutterBridge = new FlutterInteropBridge(testRelayUrls, privateKeyNsec, true)
  const irisClientServer = new IrisClientServer(await getAvailablePort())
  const irisClientBaseUrl = await irisClientServer.start()
  const irisClientContext = await browser.newContext()
  await seedIrisClientRelay(irisClientContext, testRelayUrls)
  const irisClientPage = await irisClientContext.newPage()

  try {
    const flutterReady = await flutterBridge.start()
    expect(flutterReady.pubkeyHex).toBe(expectedPubkeyHex)
    const silentRelayConnectionsReady = waitForRelayConnectionCount(silentRelay, 3, 120000)
    await waitForNextCreatedAtSecond()

    await loginWithStoredKey(webPage)
    await loginIrisClientWithKey(irisClientPage, irisClientBaseUrl, privateKeyNsec)
    await waitForIrisClientRelays(irisClientPage)
    await ensureIrisClientCurrentDeviceRegistered(irisClientPage, irisClientBaseUrl)

    await webPage.getByRole('button', { name: 'New Chat' }).click()
    await webPage
      .getByPlaceholder('Paste invite link')
      .fill(`https://chat.iris.to/#${expectedNpub}`)
    await expect(webPage.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20000 })

    await waitForLatestOwnerAppKeysDeviceCount(testRelay, expectedPubkeyHex, 3, 30000)

    await openIrisClientSelfChat(irisClientPage)
    const flutterSelfSession = await flutterBridge.command<{ sessionId: string }>(
      'ensure_session_for_recipient',
      {
        recipientPubkeyHex: expectedPubkeyHex,
      },
      30000
    )

    const flutterMessages = [
      `flutter->all same key #1 ${Date.now()}`,
      `flutter->all same key #2 ${Date.now() + 1}`,
    ]
    await sendFlutterMessages(flutterBridge, flutterSelfSession.sessionId, flutterMessages)
    for (const text of flutterMessages) {
      await expectChatMessageVisible(webPage, text)
      await expectIrisClientMessageVisible(irisClientPage, text)
    }

    const irisClientMessages = [
      `iris-client->all same key #1 ${Date.now()}`,
      `iris-client->all same key #2 ${Date.now() + 1}`,
    ]
    await sendIrisClientMessages(irisClientPage, irisClientMessages)
    for (const text of irisClientMessages) {
      await expectChatMessageVisible(webPage, text)
    }
    await expectFlutterMessages(flutterBridge, irisClientMessages)

    const webMessages = [
      `web->all same key #1 ${Date.now()}`,
      `web->all same key #2 ${Date.now() + 1}`,
    ]
    await sendWebMessages(webPage, webMessages)
    for (const text of webMessages) {
      await expectChatMessageVisible(webPage, text)
      await expectIrisClientMessageVisible(irisClientPage, text)
    }
    await expectFlutterMessages(flutterBridge, webMessages)
    await silentRelayConnectionsReady
  } finally {
    await irisClientContext.close()
    await irisClientServer.stop()
    await webContext.close()
    await flutterBridge.stop()
  }
})

test('self-chat interop across web, flutter, and iris-client still receives after flutter restart', async ({
  browser,
  silentRelay,
  testRelay,
  testRelayUrls,
}) => {
  test.skip(!RUN_FLUTTER_INTEROP, 'Set IRIS_FLUTTER_INTEROP=1 to run Flutter interop tests')
  test.skip(process.platform !== 'darwin', 'Requires macOS')
  test.skip(!fs.existsSync(FLUTTER_REPO), `Flutter repo missing: ${FLUTTER_REPO}`)
  test.skip(!fs.existsSync(IRIS_CLIENT_REPO), `Iris client repo missing: ${IRIS_CLIENT_REPO}`)
  test.setTimeout(420000)

  const secretKey = generateSecretKey()
  const privkeyHex = toHex(secretKey)
  const privateKeyNsec = nip19.nsecEncode(secretKey)
  const expectedPubkeyHex = getPublicKey(secretKey).toLowerCase()
  const expectedNpub = nip19.npubEncode(expectedPubkeyHex)
  const flutterDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'iris-flutter-interop-data-'))

  const webContext = await browser.newContext()
  await useTestRelay(webContext, testRelayUrls)
  await setIdentity(webContext, privkeyHex)
  const webPage = await webContext.newPage()

  let flutterBridge = new FlutterInteropBridge(testRelayUrls, privateKeyNsec, true, flutterDataDir)
  const irisClientServer = new IrisClientServer(await getAvailablePort())
  const irisClientBaseUrl = await irisClientServer.start()
  const irisClientContext = await browser.newContext()
  await seedIrisClientRelay(irisClientContext, testRelayUrls)
  const irisClientPage = await irisClientContext.newPage()

  try {
    const flutterReady = await flutterBridge.start()
    expect(flutterReady.pubkeyHex).toBe(expectedPubkeyHex)
    const silentRelayConnectionsReady = waitForRelayConnectionCount(silentRelay, 4, 180000)
    await waitForNextCreatedAtSecond()

    await loginWithStoredKey(webPage)
    await loginIrisClientWithKey(irisClientPage, irisClientBaseUrl, privateKeyNsec)
    await waitForIrisClientRelays(irisClientPage)
    await ensureIrisClientCurrentDeviceRegistered(irisClientPage, irisClientBaseUrl)

    await webPage.getByRole('button', { name: 'New Chat' }).click()
    await webPage
      .getByPlaceholder('Paste invite link')
      .fill(`https://chat.iris.to/#${expectedNpub}`)
    await expect(webPage.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20000 })

    await waitForLatestOwnerAppKeysDeviceCount(testRelay, expectedPubkeyHex, 3, 30000)
    await openIrisClientSelfChat(irisClientPage)
    await flutterBridge.command<{ sessionId: string }>(
      'ensure_session_for_recipient',
      {
        recipientPubkeyHex: expectedPubkeyHex,
      },
      30000
    )

    const preRestartWebMessages = [
      `web pre-restart #1 ${Date.now()}`,
      `web pre-restart #2 ${Date.now() + 1}`,
    ]
    await sendWebMessages(webPage, preRestartWebMessages)
    for (const text of preRestartWebMessages) {
      await expectIrisClientMessageVisible(irisClientPage, text)
    }
    await expectFlutterMessages(flutterBridge, preRestartWebMessages)

    const preRestartIrisClientMessages = [
      `iris-client pre-restart #1 ${Date.now()}`,
      `iris-client pre-restart #2 ${Date.now() + 1}`,
    ]
    await sendIrisClientMessages(irisClientPage, preRestartIrisClientMessages)
    for (const text of preRestartIrisClientMessages) {
      await expectChatMessageVisible(webPage, text)
    }
    await expectFlutterMessages(flutterBridge, preRestartIrisClientMessages)

    await flutterBridge.stop()
    flutterBridge = new FlutterInteropBridge(testRelayUrls, privateKeyNsec, true, flutterDataDir)
    const reopenedFlutterReady = await flutterBridge.start()
    expect(reopenedFlutterReady.pubkeyHex).toBe(expectedPubkeyHex)
    expect(reopenedFlutterReady.devicePubkeyHex).toBe(flutterReady.devicePubkeyHex)

    const webPostRestartMessages = [
      `web post-restart #1 ${Date.now()}`,
      `web post-restart #2 ${Date.now() + 1}`,
    ]
    await sendWebMessages(webPage, webPostRestartMessages)
    for (const text of webPostRestartMessages) {
      await expectChatMessageVisible(webPage, text)
      await expectIrisClientMessageVisible(irisClientPage, text)
    }
    await expectFlutterMessages(flutterBridge, webPostRestartMessages)

    const irisClientPostRestartMessages = [
      `iris-client post-restart #1 ${Date.now()}`,
      `iris-client post-restart #2 ${Date.now() + 1}`,
    ]
    await sendIrisClientMessages(irisClientPage, irisClientPostRestartMessages)
    for (const text of irisClientPostRestartMessages) {
      await expectChatMessageVisible(webPage, text)
    }
    await expectFlutterMessages(flutterBridge, irisClientPostRestartMessages)
    await silentRelayConnectionsReady
  } finally {
    await irisClientContext.close()
    await irisClientServer.stop()
    await webContext.close()
    await flutterBridge.stop()
    await fsp.rm(flutterDataDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('flutter nsec owner + iris-client sibling interop with web owner + linked web sibling', async ({
  browser,
  silentRelay,
  testRelay,
  testRelayUrls,
}) => {
  test.skip(!RUN_FLUTTER_INTEROP, 'Set IRIS_FLUTTER_INTEROP=1 to run Flutter interop tests')
  test.skip(process.platform !== 'darwin', 'Requires macOS')
  test.skip(!fs.existsSync(FLUTTER_REPO), `Flutter repo missing: ${FLUTTER_REPO}`)
  test.skip(!fs.existsSync(IRIS_CLIENT_REPO), `Iris client repo missing: ${IRIS_CLIENT_REPO}`)
  test.setTimeout(420000)

  const aliceSecret = generateSecretKey()
  const aliceNsec = nip19.nsecEncode(aliceSecret)
  const alicePubkeyHex = getPublicKey(aliceSecret).toLowerCase()

  const bobOwnerSecret = generateSecretKey()
  const bobOwnerPrivkeyHex = toHex(bobOwnerSecret)
  const bobOwnerPubkeyHex = getPublicKey(bobOwnerSecret).toLowerCase()

  const bobOwnerContext = await browser.newContext()
  const bobLinkedContext = await browser.newContext()
  await useTestRelay(bobOwnerContext, testRelayUrls)
  await useTestRelay(bobLinkedContext, testRelayUrls)
  await setIdentity(bobOwnerContext, bobOwnerPrivkeyHex)
  await clearIdentity(bobLinkedContext)

  const bobOwnerPage = await bobOwnerContext.newPage()
  const bobLinkedPage = await bobLinkedContext.newPage()

  const flutterBridge = new FlutterInteropBridge(testRelayUrls, aliceNsec, true)
  const irisClientServer = new IrisClientServer(await getAvailablePort())
  const irisClientBaseUrl = await irisClientServer.start()
  const irisClientContext = await browser.newContext()
  await seedIrisClientRelay(irisClientContext, testRelayUrls)
  const irisClientPage = await irisClientContext.newPage()

  try {
    const flutterReady = await flutterBridge.start()
    expect(flutterReady.pubkeyHex).toBe(alicePubkeyHex)
    const silentRelayConnectionsReady = waitForRelayConnectionCount(silentRelay, 4, 180000)
    await waitForNextCreatedAtSecond()

    await loginWithStoredKey(bobOwnerPage)
    await registerDevice(bobOwnerPage)

    await loginIrisClientWithKey(irisClientPage, irisClientBaseUrl, aliceNsec)
    await waitForIrisClientRelays(irisClientPage)
    await ensureIrisClientCurrentDeviceRegistered(irisClientPage, irisClientBaseUrl)
    await waitForLatestOwnerAppKeysDeviceCount(testRelay, alicePubkeyHex, 2, 30000)

    const aliceInvite = await flutterBridge.command<{ inviteUrl: string }>(
      'create_invite',
      { maxUses: 5 },
      30000
    )

    await bobOwnerPage.getByRole('button', { name: 'New Chat' }).click()
    await bobOwnerPage.getByPlaceholder('Paste invite link').fill(aliceInvite.inviteUrl)
    await expect(bobOwnerPage.getByPlaceholder('Type a message...')).toBeVisible({
      timeout: 20000,
    })

    const bobBootstrap = `bob boot ${Date.now()}`
    await bobOwnerPage.getByPlaceholder('Type a message...').fill(bobBootstrap)
    await bobOwnerPage.getByRole('button', { name: 'Send' }).click()
    const aliceFlutterSession = await flutterBridge.command<{ sessionId: string }>(
      'wait_for_message_meta',
      {
        text: bobBootstrap,
        timeoutMs: 40000,
        incomingOnly: true,
      },
      50000
    )

    await openIrisClientChatFromList(irisClientPage, bobBootstrap)
    await expect(
      irisClientPage.locator('.whitespace-pre-wrap').getByText(bobBootstrap).last()
    ).toBeVisible({ timeout: 60000 })

    await openLinkThisDevice(bobLinkedPage)
    const bobLinkInviteUrl = await getLinkInviteUrl(bobLinkedPage)
    await acceptLinkInvite(bobOwnerPage, bobLinkInviteUrl)
    await expect(bobLinkedPage.getByRole('button', { name: 'New Chat' })).toBeVisible({
      timeout: 30000,
    })
    await waitForLatestOwnerAppKeysDeviceCount(testRelay, bobOwnerPubkeyHex, 2, 30000)

    const bobOwnerSelfSyncMessage = `bs ${Date.now()}`
    await bobOwnerPage.getByPlaceholder('Type a message...').fill(bobOwnerSelfSyncMessage)
    await bobOwnerPage.getByRole('button', { name: 'Send' }).click()
    await openChatFromList(bobLinkedPage, bobOwnerSelfSyncMessage)
    await expect(
      bobLinkedPage
        .locator('.max-w-\\[85\\%\\]')
        .filter({ hasText: bobOwnerSelfSyncMessage })
        .first()
    ).toBeVisible({ timeout: 30000 })
    await expect(
      irisClientPage
        .locator('.whitespace-pre-wrap')
        .getByText(bobOwnerSelfSyncMessage)
        .last()
    ).toBeVisible({ timeout: 60000 })
    await flutterBridge.command(
      'wait_for_message_meta',
      {
        text: bobOwnerSelfSyncMessage,
        timeoutMs: 40000,
        incomingOnly: true,
      },
      50000
    )

    const aliceFlutterMessages = [`af #1 ${Date.now()}`, `af #2 ${Date.now() + 1}`]
    await sendFlutterMessages(flutterBridge, aliceFlutterSession.sessionId, aliceFlutterMessages)
    for (const text of aliceFlutterMessages) {
      await expectIrisClientMessageVisible(irisClientPage, text)
      await expectChatMessageVisible(bobOwnerPage, text)
      await expectChatMessageVisible(bobLinkedPage, text)
    }

    const aliceIrisClientMessages = [`ai #1 ${Date.now()}`, `ai #2 ${Date.now() + 1}`]
    await sendIrisClientMessages(irisClientPage, aliceIrisClientMessages)
    for (const text of aliceIrisClientMessages) {
      await expectChatMessageVisible(bobOwnerPage, text)
      await expectChatMessageVisible(bobLinkedPage, text)
    }
    await expectFlutterMessages(flutterBridge, aliceIrisClientMessages)

    const bobOwnerMessages = [`bo #1 ${Date.now()}`, `bo #2 ${Date.now() + 1}`]
    await sendWebMessages(bobOwnerPage, bobOwnerMessages)
    for (const text of bobOwnerMessages) {
      await expectChatMessageVisible(bobLinkedPage, text)
      await expectIrisClientMessageVisible(irisClientPage, text)
    }
    await expectFlutterMessages(flutterBridge, bobOwnerMessages, true)

    const bobLinkedMessages = [`bl #1 ${Date.now()}`, `bl #2 ${Date.now() + 1}`]
    await sendWebMessages(bobLinkedPage, bobLinkedMessages)
    for (const text of bobLinkedMessages) {
      await expectChatMessageVisible(bobOwnerPage, text)
      await expectIrisClientMessageVisible(irisClientPage, text)
    }
    await expectFlutterMessages(flutterBridge, bobLinkedMessages, true)
    await silentRelayConnectionsReady
  } finally {
    await irisClientContext.close()
    await irisClientServer.stop()
    await bobOwnerContext.close()
    await bobLinkedContext.close()
    await flutterBridge.stop()
  }
})

test('flutter existing-nsec invite interop (different keys) between flutter and web', async ({
  browser,
  silentRelay,
  testRelayUrls,
}) => {
  test.skip(!RUN_FLUTTER_INTEROP, 'Set IRIS_FLUTTER_INTEROP=1 to run Flutter interop tests')
  test.skip(process.platform !== 'darwin', 'Requires macOS')
  test.skip(!fs.existsSync(FLUTTER_REPO), `Flutter repo missing: ${FLUTTER_REPO}`)
  test.setTimeout(240000)

  const flutterSecret = generateSecretKey()
  const flutterNsec = nip19.nsecEncode(flutterSecret)
  const expectedFlutterPubkeyHex = getPublicKey(flutterSecret).toLowerCase()

  const context = await browser.newContext()
  await useTestRelay(context, testRelayUrls)
  const page = await context.newPage()

  const bridge = new FlutterInteropBridge(testRelayUrls, flutterNsec, true)

  try {
    const ready = await bridge.start()
    expect(ready.pubkeyHex).toBe(expectedFlutterPubkeyHex)
    const silentRelayConnectionsReady = waitForRelayConnectionCount(silentRelay, 2, 120000)
    await waitForNextCreatedAtSecond()

    const created = await bridge.command<{ inviteUrl: string }>(
      'create_invite',
      { maxUses: 5 },
      30000
    )

    await loginAnonymously(page)
    await getStoredIdentityPrivkeyHex(page)

    await page.getByRole('button', { name: 'New Chat' }).click()
    await page.getByPlaceholder('Paste invite link').fill(created.inviteUrl)
    await expect(page.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20000 })

    const webMessage = 'web->flutter invite interop'
    await page.getByPlaceholder('Type a message...').fill(webMessage)
    await page.getByRole('button', { name: 'Send' }).click()
    const flutterIncomingMessage = await bridge.command<{ sessionId: string }>(
      'wait_for_message_meta',
      {
        text: webMessage,
        timeoutMs: 30000,
        incomingOnly: true,
      },
      40000
    )

    const flutterMessage = 'flutter->web invite interop'
    await bridge.command(
      'send_message_ui',
      {
        sessionId: flutterIncomingMessage.sessionId,
        text: flutterMessage,
      },
      30000
    )

    await expectChatMessageVisible(page, flutterMessage)
    await silentRelayConnectionsReady
  } finally {
    await context.close()
    await bridge.stop()
  }
})

test('group interop (same key) between web and flutter', async ({
  browser,
  silentRelay,
  testRelayUrls,
}) => {
  test.skip(!RUN_FLUTTER_INTEROP, 'Set IRIS_FLUTTER_INTEROP=1 to run Flutter interop tests')
  test.skip(process.platform !== 'darwin', 'Requires macOS')
  test.skip(!fs.existsSync(FLUTTER_REPO), `Flutter repo missing: ${FLUTTER_REPO}`)
  test.setTimeout(240000)

  const secretKey = generateSecretKey()
  const privkeyHex = toHex(secretKey)
  const privateKeyNsec = nip19.nsecEncode(secretKey)
  const expectedPubkeyHex = getPublicKey(secretKey).toLowerCase()
  const groupName = `interop-group-${Date.now()}`

  const context = await browser.newContext()
  await useTestRelay(context, testRelayUrls)
  await setIdentity(context, privkeyHex)
  const page = await context.newPage()

  const bridge = new FlutterInteropBridge(testRelayUrls, privateKeyNsec, true)

  try {
    const ready = await bridge.start()
    expect(ready.pubkeyHex).toBe(expectedPubkeyHex)
    const silentRelayConnectionsReady = waitForRelayConnectionCount(silentRelay, 2, 120000)
    await waitForNextCreatedAtSecond()

    await loginWithStoredKey(page)

    // Bootstrap a self-session first so Flutter can sender-copy group metadata
    // across clients via pairwise transport.
    const dmBootstrapInvite = await bridge.command<{ inviteUrl: string }>(
      'create_invite',
      { maxUses: 5 },
      30000
    )
    await page.getByRole('button', { name: 'New Chat' }).click()
    await page.getByPlaceholder('Paste invite link').fill(dmBootstrapInvite.inviteUrl)
    await expect(page.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20000 })
    const dmBootstrapText = 'group-bootstrap-self-session'
    await page.getByPlaceholder('Type a message...').fill(dmBootstrapText)
    await page.getByRole('button', { name: 'Send' }).click()
    const flutterBootstrapMessage = await bridge.command<{ sessionId: string }>(
      'wait_for_message_meta',
      { text: dmBootstrapText, timeoutMs: 30000 },
      40000
    )
    const dmBootstrapAck = 'group-bootstrap-self-session-ack'
    await bridge.command(
      'send_message_ui',
      {
        sessionId: flutterBootstrapMessage.sessionId,
        text: dmBootstrapAck,
      },
      30000
    )
    await expectChatMessageVisible(page, dmBootstrapAck)

    const pubkey = await bridge.command<{ pubkeyHex: string }>('get_pubkey', {}, 10000)
    const created = await bridge.command<{ groupId: string }>(
      'create_group',
      {
        name: groupName,
        memberPubkeysHex: [pubkey.pubkeyHex],
      },
      30000
    )

    await openGroupFromSidebar(page, groupName)
    await acceptOpenGroupIfNeeded(page)

    const flutterMessage = 'flutter->web group interop'
    await bridge.command(
      'send_group_message',
      {
        groupId: created.groupId,
        text: flutterMessage,
      },
      30000
    )

    await expectChatMessageVisible(page, flutterMessage)

    const webMessage = 'web->flutter group interop'
    await page.getByPlaceholder('Type a message...').fill(webMessage)
    await page.getByRole('button', { name: 'Send' }).click()

    await bridge.command(
      'wait_for_group_message',
      {
        groupId: created.groupId,
        text: webMessage,
        timeoutMs: 30000,
      },
      40000
    )
    await silentRelayConnectionsReady
  } finally {
    await context.close()
    await bridge.stop()
  }
})

test('group interop (different keys) web creates group and flutter receives it', async ({
  browser,
  silentRelay,
  testRelayUrls,
}) => {
  test.skip(!RUN_FLUTTER_INTEROP, 'Set IRIS_FLUTTER_INTEROP=1 to run Flutter interop tests')
  test.skip(process.platform !== 'darwin', 'Requires macOS')
  test.skip(!fs.existsSync(FLUTTER_REPO), `Flutter repo missing: ${FLUTTER_REPO}`)
  test.setTimeout(240000)

  const flutterSecret = generateSecretKey()
  const flutterNsec = nip19.nsecEncode(flutterSecret)
  const expectedFlutterPubkeyHex = getPublicKey(flutterSecret).toLowerCase()
  const groupName = `web-to-flutter-group-${Date.now()}`

  const context = await browser.newContext()
  await useTestRelay(context, testRelayUrls)
  const page = await context.newPage()

  const bridge = new FlutterInteropBridge(testRelayUrls, flutterNsec, true)

  try {
    const ready = await bridge.start()
    expect(ready.pubkeyHex).toBe(expectedFlutterPubkeyHex)
    const silentRelayConnectionsReady = waitForRelayConnectionCount(silentRelay, 2, 120000)
    await waitForNextCreatedAtSecond()

    await loginAnonymously(page)
    const webPrivkeyHex = await getStoredIdentityPrivkeyHex(page)
    const webPubkeyHex = getPublicKey(hexToBytes(webPrivkeyHex)).toLowerCase()

    const flutterInvite = await bridge.command<{ inviteUrl: string }>(
      'create_invite',
      { maxUses: 5 },
      30000
    )

    await page.getByRole('button', { name: 'New Chat' }).click()
    await page.getByPlaceholder('Paste invite link').fill(flutterInvite.inviteUrl)
    await expect(page.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20000 })

    const dmBootstrapText = `web->flutter group bootstrap ${Date.now()}`
    await page.getByPlaceholder('Type a message...').fill(dmBootstrapText)
    await page.getByRole('button', { name: 'Send' }).click()
    const flutterBootstrapMessage = await bridge.command<{ sessionId: string }>(
      'wait_for_message_meta',
      {
        text: dmBootstrapText,
        timeoutMs: 30000,
        incomingOnly: true,
      },
      40000
    )
    const dmBootstrapAck = `flutter->web group bootstrap ack ${Date.now()}`
    await bridge.command(
      'send_message_ui',
      {
        sessionId: flutterBootstrapMessage.sessionId,
        text: dmBootstrapAck,
      },
      30000
    )
    await expectChatMessageVisible(page, dmBootstrapAck)

    await page.getByRole('button', { name: 'Back' }).click()
    await expect(page.getByRole('button', { name: 'Create Group' })).toBeVisible({
      timeout: 20000,
    })

    await page.getByRole('button', { name: 'Create Group' }).click()
    const createGroupView = page.getByTestId('create-group-view')
    await createGroupView.getByTestId('create-group-member').first().click()
    await createGroupView.getByTestId('create-group-next').click()
    await page.getByPlaceholder('Enter group name...').fill(groupName)
    await createGroupView.getByTestId('create-group-submit').click()

    const flutterGroup = await bridge.command<{ groupId: string }>(
      'wait_for_group_named',
      {
        name: groupName,
        timeoutMs: 30000,
      },
      40000
    )

    await bridge.command(
      'accept_group',
      {
        groupId: flutterGroup.groupId,
      },
      20000
    )

    const webMessage = `web->flutter group ${Date.now()}`
    await page.getByPlaceholder('Type a message...').fill(webMessage)
    await page.getByRole('button', { name: 'Send' }).click()
    await bridge.command(
      'wait_for_group_message',
      {
        groupId: flutterGroup.groupId,
        text: webMessage,
        timeoutMs: 30000,
        incomingOnly: true,
      },
      40000
    )

    const flutterMessage = `flutter->web group ${Date.now()}`
    await bridge.command(
      'send_group_message',
      {
        groupId: flutterGroup.groupId,
        text: flutterMessage,
      },
      30000
    )

    await expectChatMessageVisible(page, flutterMessage)

    expect(webPubkeyHex).toHaveLength(64)
    await silentRelayConnectionsReady
  } finally {
    await context.close()
    await bridge.stop()
  }
})

test('group interop (different keys) flutter creates group and web sees flutter messages', async ({
  browser,
  silentRelay,
  testRelayUrls,
}) => {
  test.skip(!RUN_FLUTTER_INTEROP, 'Set IRIS_FLUTTER_INTEROP=1 to run Flutter interop tests')
  test.skip(process.platform !== 'darwin', 'Requires macOS')
  test.skip(!fs.existsSync(FLUTTER_REPO), `Flutter repo missing: ${FLUTTER_REPO}`)
  test.setTimeout(240000)

  const flutterSecret = generateSecretKey()
  const flutterNsec = nip19.nsecEncode(flutterSecret)
  const expectedFlutterPubkeyHex = getPublicKey(flutterSecret).toLowerCase()
  const groupName = `flutter-to-web-group-${Date.now()}`

  const context = await browser.newContext()
  await useTestRelay(context, testRelayUrls)
  const page = await context.newPage()

  const bridge = new FlutterInteropBridge(testRelayUrls, flutterNsec, true)

  try {
    const ready = await bridge.start()
    expect(ready.pubkeyHex).toBe(expectedFlutterPubkeyHex)
    const silentRelayConnectionsReady = waitForRelayConnectionCount(silentRelay, 2, 120000)
    await waitForNextCreatedAtSecond()

    await loginAnonymously(page)
    const webPrivkeyHex = await getStoredIdentityPrivkeyHex(page)
    const webPubkeyHex = getPublicKey(hexToBytes(webPrivkeyHex)).toLowerCase()

    const flutterInvite = await bridge.command<{ inviteUrl: string }>(
      'create_invite',
      { maxUses: 5 },
      30000
    )

    await page.getByRole('button', { name: 'New Chat' }).click()
    await page.getByPlaceholder('Paste invite link').fill(flutterInvite.inviteUrl)
    await expect(page.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20000 })

    const dmBootstrapText = `web->flutter group create bootstrap ${Date.now()}`
    await page.getByPlaceholder('Type a message...').fill(dmBootstrapText)
    await page.getByRole('button', { name: 'Send' }).click()

    const flutterBootstrapMessage = await bridge.command<{ sessionId: string }>(
      'wait_for_message_meta',
      {
        text: dmBootstrapText,
        timeoutMs: 30000,
        incomingOnly: true,
      },
      40000
    )
    const dmBootstrapAck = `flutter->web group create ack ${Date.now()}`
    await bridge.command(
      'send_message_ui',
      {
        sessionId: flutterBootstrapMessage.sessionId,
        text: dmBootstrapAck,
      },
      30000
    )
    await expectChatMessageVisible(page, dmBootstrapAck)

    const flutterGroup = await bridge.command<{ groupId: string }>(
      'create_group',
      {
        name: groupName,
        memberPubkeysHex: [webPubkeyHex],
      },
      30000
    )

    await openGroupFromSidebar(page, groupName)
    await acceptOpenGroupIfNeeded(page)

    const flutterMessage = `flutter->web created group ${Date.now()}`
    await bridge.command(
      'send_group_message',
      {
        groupId: flutterGroup.groupId,
        text: flutterMessage,
      },
      30000
    )

    await expect(
      page.locator('.max-w-\\[85\\%\\]').filter({ hasText: flutterMessage }).first()
    ).toBeVisible({ timeout: 30000 })

    const webMessage = `web->flutter created group ${Date.now()}`
    await page.getByPlaceholder('Type a message...').fill(webMessage)
    await page.getByRole('button', { name: 'Send' }).click()

    await bridge.command(
      'wait_for_group_message',
      {
        groupId: flutterGroup.groupId,
        text: webMessage,
        timeoutMs: 30000,
        incomingOnly: true,
      },
      40000
    )
    await silentRelayConnectionsReady
  } finally {
    await context.close()
    await bridge.stop()
  }
})

test('group interop (same key) between web-created groups and flutter', async ({
  browser,
  silentRelay,
  testRelayUrls,
}) => {
  test.skip(!RUN_FLUTTER_INTEROP, 'Set IRIS_FLUTTER_INTEROP=1 to run Flutter interop tests')
  test.skip(process.platform !== 'darwin', 'Requires macOS')
  test.skip(!fs.existsSync(FLUTTER_REPO), `Flutter repo missing: ${FLUTTER_REPO}`)
  test.setTimeout(240000)

  const secretKey = generateSecretKey()
  const privkeyHex = toHex(secretKey)
  const privateKeyNsec = nip19.nsecEncode(secretKey)
  const expectedPubkeyHex = getPublicKey(secretKey).toLowerCase()
  const groupName = `web-created-interop-group-${Date.now()}`

  const context = await browser.newContext()
  await useTestRelay(context, testRelayUrls)
  await setIdentity(context, privkeyHex)
  const page = await context.newPage()

  const bridge = new FlutterInteropBridge(testRelayUrls, privateKeyNsec, true)

  try {
    const ready = await bridge.start()
    expect(ready.pubkeyHex).toBe(expectedPubkeyHex)
    const silentRelayConnectionsReady = waitForRelayConnectionCount(silentRelay, 2, 120000)
    await waitForNextCreatedAtSecond()

    await loginWithStoredKey(page)

    // Bootstrap a self-session first so web can sender-copy group metadata
    // back to Flutter via pairwise transport.
    const dmBootstrapInvite = await bridge.command<{ inviteUrl: string }>(
      'create_invite',
      { maxUses: 5 },
      30000
    )
    await page.getByRole('button', { name: 'New Chat' }).click()
    await page.getByPlaceholder('Paste invite link').fill(dmBootstrapInvite.inviteUrl)
    await expect(page.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20000 })
    const dmBootstrapText = 'web-created-group-bootstrap-self-session'
    await page.getByPlaceholder('Type a message...').fill(dmBootstrapText)
    await page.getByRole('button', { name: 'Send' }).click()
    const flutterBootstrapMessage = await bridge.command<{ sessionId: string }>(
      'wait_for_message_meta',
      { text: dmBootstrapText, timeoutMs: 30000 },
      40000
    )
    const dmBootstrapAck = 'web-created-group-bootstrap-self-session-ack'
    await bridge.command(
      'send_message_ui',
      {
        sessionId: flutterBootstrapMessage.sessionId,
        text: dmBootstrapAck,
      },
      30000
    )
    await expectChatMessageVisible(page, dmBootstrapAck)

    await page.getByRole('button', { name: 'Back' }).click()
    await expect(page.getByRole('button', { name: 'Create Group' })).toBeVisible({
      timeout: 20000,
    })

    await page.getByRole('button', { name: 'Create Group' }).click()
    const createGroupView = page.getByTestId('create-group-view')
    await createGroupView.getByTestId('create-group-member').first().click()
    await createGroupView.getByTestId('create-group-next').click()
    await page.getByPlaceholder('Enter group name...').fill(groupName)
    await createGroupView.getByTestId('create-group-submit').click()

    const flutterGroup = await bridge.command<{ groupId: string }>(
      'wait_for_group_named',
      {
        name: groupName,
        timeoutMs: 30000,
      },
      40000
    )

    await bridge.command(
      'accept_group',
      {
        groupId: flutterGroup.groupId,
      },
      20000
    )

    const webMessage = 'web->flutter web-created group interop'
    await page.getByPlaceholder('Type a message...').fill(webMessage)
    await page.getByRole('button', { name: 'Send' }).click()

    await bridge.command(
      'wait_for_group_message',
      {
        groupId: flutterGroup.groupId,
        text: webMessage,
        timeoutMs: 30000,
      },
      40000
    )

    const flutterMessage = 'flutter->web web-created group interop'
    await bridge.command(
      'send_group_message',
      {
        groupId: flutterGroup.groupId,
        text: flutterMessage,
      },
      30000
    )

    await expect(
      page.locator('.max-w-\\[85\\%\\]').filter({ hasText: flutterMessage }).first()
    ).toBeVisible({ timeout: 30000 })
    await silentRelayConnectionsReady
  } finally {
    await context.close()
    await bridge.stop()
  }
})

import { test, expect, useTestRelay } from './fixtures'
import type { BrowserContext, Page } from '@playwright/test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const RUN_FLUTTER_INTEROP = process.env.IRIS_FLUTTER_INTEROP === '1'
const FLUTTER_REPO = path.resolve(__dirname, '../../iris-chat-flutter')

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

async function openGroupFromSidebar(page: Page, groupName: string): Promise<void> {
  await page.getByTestId('sidebar-tab-all').click()
  const groupListItem = page
    .getByTestId('sidebar-chat-list')
    .getByRole('button', { name: new RegExp(groupName) })
    .first()
  await expect(groupListItem).toBeVisible({ timeout: 30000 })
  await groupListItem.click()
}

async function acceptOpenGroupIfNeeded(page: Page): Promise<void> {
  const acceptButton = page.getByRole('button', { name: 'Accept' })
  if (await acceptButton.isVisible().catch(() => false)) {
    await acceptButton.click()
  }
}

type BridgeEvent =
  | { type: 'ready'; data?: { pubkeyHex?: string; relayUrl?: string } }
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
    private readonly relayUrl: string,
    private readonly privateKeyNsec: string,
    private readonly registerDeviceOnLogin = false
  ) {}

  async start(): Promise<{ pubkeyHex: string }> {
    this.bridgeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'iris-flutter-interop-'))
    this.commandsFile = path.join(this.bridgeDir, 'commands.jsonl')
    this.eventsFile = path.join(this.bridgeDir, 'events.jsonl')

    this.child = spawn(
      'flutter',
      [
        'test',
        'integration_test/flutter_interop_bridge_macos_suite.dart',
        '-d',
        'macos',
        `--dart-define=IRIS_INTEROP_RELAY_URL=${this.relayUrl}`,
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

    await this.waitForProcessExit(5000).catch(() => {
      if (!this.child) return
      this.child.kill('SIGTERM')
    })

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

test('self-chat interop (same key) between web and flutter', async ({ browser, testRelayUrl }) => {
  test.skip(!RUN_FLUTTER_INTEROP, 'Set IRIS_FLUTTER_INTEROP=1 to run Flutter interop tests')
  test.skip(process.platform !== 'darwin', 'Requires macOS')
  test.skip(!fs.existsSync(FLUTTER_REPO), `Flutter repo missing: ${FLUTTER_REPO}`)
  test.setTimeout(240000)

  const secretKey = generateSecretKey()
  const privkeyHex = toHex(secretKey)
  const privateKeyNsec = nip19.nsecEncode(secretKey)
  const expectedPubkeyHex = getPublicKey(secretKey).toLowerCase()

  const context = await browser.newContext()
  await useTestRelay(context, testRelayUrl)
  await setIdentity(context, privkeyHex)
  const page = await context.newPage()

  const bridge = new FlutterInteropBridge(testRelayUrl, privateKeyNsec)

  try {
    const ready = await bridge.start()
    expect(ready.pubkeyHex).toBe(expectedPubkeyHex)

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
    await bridge.command('wait_for_message', { text: webMessage, timeoutMs: 30000 }, 40000)

    const pubkey = await bridge.command<{ pubkeyHex: string }>('get_pubkey', {}, 10000)
    const session = await bridge.command<{ sessionId: string }>(
      'wait_for_session',
      {
        recipientPubkeyHex: pubkey.pubkeyHex,
        timeoutMs: 30000,
      },
      40000
    )

    const flutterMessage = 'flutter->web self interop'
    await bridge.command(
      'send_message',
      {
        sessionId: session.sessionId,
        text: flutterMessage,
      },
      30000
    )

    await expect(
      page.locator('.max-w-\\[85\\%\\]').filter({ hasText: flutterMessage }).first()
    ).toBeVisible({ timeout: 30000 })
  } finally {
    await context.close()
    await bridge.stop()
  }
})

test('flutter existing-nsec invite interop (different keys) between flutter and web', async ({
  browser,
  testRelayUrl,
}) => {
  test.skip(!RUN_FLUTTER_INTEROP, 'Set IRIS_FLUTTER_INTEROP=1 to run Flutter interop tests')
  test.skip(process.platform !== 'darwin', 'Requires macOS')
  test.skip(!fs.existsSync(FLUTTER_REPO), `Flutter repo missing: ${FLUTTER_REPO}`)
  test.setTimeout(240000)

  const flutterSecret = generateSecretKey()
  const flutterNsec = nip19.nsecEncode(flutterSecret)
  const expectedFlutterPubkeyHex = getPublicKey(flutterSecret).toLowerCase()

  const context = await browser.newContext()
  await useTestRelay(context, testRelayUrl)
  const page = await context.newPage()

  const bridge = new FlutterInteropBridge(testRelayUrl, flutterNsec, true)

  try {
    const ready = await bridge.start()
    expect(ready.pubkeyHex).toBe(expectedFlutterPubkeyHex)

    const created = await bridge.command<{ inviteUrl: string }>(
      'create_invite',
      { maxUses: 5 },
      30000
    )

    await loginAnonymously(page)
    const webPrivkeyHex = await getStoredIdentityPrivkeyHex(page)
    const webPubkeyHex = getPublicKey(hexToBytes(webPrivkeyHex)).toLowerCase()

    await page.getByRole('button', { name: 'New Chat' }).click()
    await page.getByPlaceholder('Paste invite link').fill(created.inviteUrl)
    await expect(page.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20000 })

    const flutterSession = await bridge.command<{ sessionId: string }>(
      'wait_for_session',
      {
        recipientPubkeyHex: webPubkeyHex,
        timeoutMs: 30000,
      },
      40000
    )

    const webMessage = 'web->flutter invite interop'
    await page.getByPlaceholder('Type a message...').fill(webMessage)
    await page.getByRole('button', { name: 'Send' }).click()
    await bridge.command(
      'wait_for_message',
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
        sessionId: flutterSession.sessionId,
        text: flutterMessage,
      },
      30000
    )

    await expect(
      page.locator('.max-w-\\[85\\%\\]').filter({ hasText: flutterMessage }).first()
    ).toBeVisible({ timeout: 30000 })
  } finally {
    await context.close()
    await bridge.stop()
  }
})

test('group interop (same key) between web and flutter', async ({ browser, testRelayUrl }) => {
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
  await useTestRelay(context, testRelayUrl)
  await setIdentity(context, privkeyHex)
  const page = await context.newPage()

  const bridge = new FlutterInteropBridge(testRelayUrl, privateKeyNsec)

  try {
    const ready = await bridge.start()
    expect(ready.pubkeyHex).toBe(expectedPubkeyHex)

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
    await bridge.command('wait_for_message', { text: dmBootstrapText, timeoutMs: 30000 }, 40000)

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

    await expect(
      page.locator('.max-w-\\[85\\%\\]').filter({ hasText: flutterMessage }).first()
    ).toBeVisible({ timeout: 30000 })

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
  } finally {
    await context.close()
    await bridge.stop()
  }
})

test('group interop (different keys) web creates group and flutter receives it', async ({
  browser,
  testRelayUrl,
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
  await useTestRelay(context, testRelayUrl)
  const page = await context.newPage()

  const bridge = new FlutterInteropBridge(testRelayUrl, flutterNsec, true)

  try {
    const ready = await bridge.start()
    expect(ready.pubkeyHex).toBe(expectedFlutterPubkeyHex)

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
    await bridge.command(
      'wait_for_message',
      {
        text: dmBootstrapText,
        timeoutMs: 30000,
        incomingOnly: true,
      },
      40000
    )

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

    await expect(
      page.locator('.max-w-\\[85\\%\\]').filter({ hasText: flutterMessage }).first()
    ).toBeVisible({ timeout: 30000 })

    expect(webPubkeyHex).toHaveLength(64)
  } finally {
    await context.close()
    await bridge.stop()
  }
})

test('group interop (different keys) flutter creates group and web sees flutter messages', async ({
  browser,
  testRelayUrl,
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
  await useTestRelay(context, testRelayUrl)
  const page = await context.newPage()

  const bridge = new FlutterInteropBridge(testRelayUrl, flutterNsec, true)

  try {
    const ready = await bridge.start()
    expect(ready.pubkeyHex).toBe(expectedFlutterPubkeyHex)

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

    await bridge.command(
      'wait_for_message',
      {
        text: dmBootstrapText,
        timeoutMs: 30000,
        incomingOnly: true,
      },
      40000
    )

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
  } finally {
    await context.close()
    await bridge.stop()
  }
})

test('group interop (same key) between web-created groups and flutter', async ({
  browser,
  testRelayUrl,
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
  await useTestRelay(context, testRelayUrl)
  await setIdentity(context, privkeyHex)
  const page = await context.newPage()

  const bridge = new FlutterInteropBridge(testRelayUrl, privateKeyNsec)

  try {
    const ready = await bridge.start()
    expect(ready.pubkeyHex).toBe(expectedPubkeyHex)

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
    await bridge.command('wait_for_message', { text: dmBootstrapText, timeoutMs: 30000 }, 40000)

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
  } finally {
    await context.close()
    await bridge.stop()
  }
})

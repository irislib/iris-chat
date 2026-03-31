import { test, expect, useTestRelay } from './fixtures'
import type { BrowserContext, Page } from '@playwright/test'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { DEFAULT_RELAYS as DEFAULT_PROD_RELAYS } from '../src/lib/defaultRelays'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FLUTTER_REPO = path.resolve(__dirname, '../../iris-chat-flutter')
const FLUTTER_MACOS_APP_BINARY = path.join(
  FLUTTER_REPO,
  'build/macos/Build/Products/Debug/iris chat.app/Contents/MacOS/iris chat'
)
const RUN_FLUTTER_INTEROP = process.env.IRIS_FLUTTER_INTEROP === '1'
const RUN_PRODUCTION_RELAYS = process.env.IRIS_FLUTTER_INTEROP_PROD === '1'
const PROD_RELAYS = (process.env.IRIS_FLUTTER_INTEROP_RELAYS ?? '')
  .split(',')
  .map((v) => v.trim())
  .filter((v) => v.length > 0)
const EFFECTIVE_PROD_RELAYS = PROD_RELAYS.length > 0 ? PROD_RELAYS : DEFAULT_PROD_RELAYS

test.describe.configure({ mode: 'serial' })

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function setIdentity(context: BrowserContext, privkeyHex: string) {
  await context.addInitScript((key: string) => {
    try {
      window.localStorage.setItem('iris-chat-identity', key)
    } catch {
      // ignore opaque origins
    }
  }, privkeyHex)
}

async function loginWithStoredKey(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible({ timeout: 30000 })
}

async function waitForNextCreatedAtSecond(): Promise<void> {
  const currentSecond = Math.floor(Date.now() / 1000)
  while (Math.floor(Date.now() / 1000) === currentSecond) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
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

async function configureRelays(context: BrowserContext, relayUrls: string[]) {
  if (!RUN_PRODUCTION_RELAYS) {
    await useTestRelay(context, relayUrls)
    return
  }

  await context.addInitScript((relayUrls: string[]) => {
    try {
      window.localStorage.setItem('iris-chat-relays', JSON.stringify(relayUrls))
    } catch {
      // ignore opaque origins
    }
  }, EFFECTIVE_PROD_RELAYS)
}

type BridgeEvent =
  | { type: 'ready'; data?: { pubkeyHex?: string; relayUrl?: string; relayUrls?: string[] } }
  | { type: 'response'; id?: string; ok?: boolean; data?: unknown; error?: string }
  | { type: string; id?: string; ok?: boolean; data?: unknown; error?: string }

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
    private readonly dataDir: string,
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
        `--dart-define=IRIS_INTEROP_DATA_DIR=${this.dataDir}`,
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

    await this.waitForProcessExit(5000).catch(() => {
      if (!this.child) return
      this.child.kill('SIGTERM')
      return this.waitForProcessExit(2000).catch(() => {
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

test('npub link interop (different keys) between web and flutter', async ({
  browser,
  silentRelay,
  testRelayUrls,
}) => {
  test.skip(!RUN_FLUTTER_INTEROP, 'Set IRIS_FLUTTER_INTEROP=1 to run Flutter interop tests')
  test.skip(process.platform !== 'darwin', 'Requires macOS')
  test.skip(!fs.existsSync(FLUTTER_REPO), `Flutter repo missing: ${FLUTTER_REPO}`)
  test.setTimeout(RUN_PRODUCTION_RELAYS ? 720000 : 240000)

  const webSecret = generateSecretKey()
  const webPrivkeyHex = toHex(webSecret)
  const webPubkeyHex = getPublicKey(webSecret).toLowerCase()

  const flutterSecret = generateSecretKey()
  const flutterNsec = nip19.nsecEncode(flutterSecret)
  const relayUrls = RUN_PRODUCTION_RELAYS ? EFFECTIVE_PROD_RELAYS : testRelayUrls
  const flutterDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'iris-flutter-interop-data-'))

  const context = await browser.newContext()
  await configureRelays(context, relayUrls)
  await setIdentity(context, webPrivkeyHex)
  const page = await context.newPage()
  const humanPauseMs = RUN_PRODUCTION_RELAYS ? 2200 : 1200
  let bridge: FlutterInteropBridge | null = null

  try {
    bridge = new FlutterInteropBridge(relayUrls, flutterNsec, flutterDataDir, true)
    const flutterReady = await bridge.start()
    await bridge.command(
      'wait_for_connected_relays',
      {
        minConnected: RUN_PRODUCTION_RELAYS ? 2 : 1,
        timeoutMs: RUN_PRODUCTION_RELAYS ? 180000 : 30000,
      },
      RUN_PRODUCTION_RELAYS ? 190000 : 40000
    )
    const silentRelayConnectionsReady = RUN_PRODUCTION_RELAYS
      ? Promise.resolve()
      : waitForRelayConnectionCount(silentRelay, 2, 120000)
    await bridge.command('ensure_default_invite_published', {}, 30000)

    await loginWithStoredKey(page)

    await page.waitForTimeout(RUN_PRODUCTION_RELAYS ? 12000 : 8000)

    const flutterNpub = nip19.npubEncode(flutterReady.pubkeyHex)
    const flutterChatUrl = `https://chat.iris.to/#${flutterNpub}`

    await page.getByRole('button', { name: 'New Chat' }).click()
    await page.getByPlaceholder('Paste invite link').fill(flutterChatUrl)
    await expect(page.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 20000 })

    const webToFlutterMessages = [
      'web->flutter npub interop #1',
      'web->flutter npub interop #2',
      'web->flutter npub interop #3',
    ]
    for (const text of webToFlutterMessages) {
      await page.getByPlaceholder('Type a message...').fill(text)
      await page.getByRole('button', { name: 'Send' }).click()
      await bridge.command('wait_for_message', { text, timeoutMs: 30000 }, 40000)
      await page.waitForTimeout(humanPauseMs)
    }

    const flutterSession = await bridge.command<{ sessionId: string }>(
      'wait_for_session',
      {
        recipientPubkeyHex: webPubkeyHex,
        timeoutMs: 30000,
      },
      40000
    )

    // Validate web -> flutter typing interop before flutter sends.
    const composer = page.getByPlaceholder('Type a message...')
    await composer.fill('typing interop probe')
    await bridge.command(
      'wait_for_typing',
      { sessionId: flutterSession.sessionId, timeoutMs: 30000, isTyping: true },
      40000
    )
    await page.waitForTimeout(humanPauseMs)
    await composer.fill('')
    await bridge.command(
      'wait_for_typing',
      { sessionId: flutterSession.sessionId, timeoutMs: 30000, isTyping: false },
      40000
    )

    // Validate flutter -> web reaction interop against a web-originated message.
    const webMsgMeta = await bridge.command<{ sessionId: string; messageId: string }>(
      'wait_for_message_meta',
      { text: webToFlutterMessages[0], timeoutMs: 30000, incomingOnly: true },
      40000
    )
    await bridge.command(
      'send_reaction',
      { sessionId: webMsgMeta.sessionId, messageId: webMsgMeta.messageId, emoji: '❤️' },
      30000
    )
    await expect(page.locator('.reaction').filter({ hasText: '❤️' }).first()).toBeVisible({
      timeout: 30000,
    })

    const flutterToWebMessages = [
      'flutter->web npub interop #1',
      'flutter->web npub interop #2',
      'flutter->web npub interop #3',
    ]
    for (const text of flutterToWebMessages) {
      await bridge.command('send_message_ui', { sessionId: flutterSession.sessionId, text }, 30000)
      await bridge.command(
        'wait_for_message',
        { text, timeoutMs: 30000, incomingOnly: false },
        40000
      )
      await expect(
        page.locator('.max-w-\\[85\\%\\]').filter({ hasText: text }).first()
      ).toBeVisible({ timeout: 30000 })
      await page.waitForTimeout(humanPauseMs)
    }

    // Burst web -> flutter traffic without per-message pacing to surface
    // subscription/update races where only the first message is observed.
    const burstMessages = Array.from({ length: RUN_PRODUCTION_RELAYS ? 8 : 5 }, (_, i) => {
      return `web->flutter burst #${i + 1} ${Date.now()}`
    })
    for (const text of burstMessages) {
      await page.getByPlaceholder('Type a message...').fill(text)
      await page.getByRole('button', { name: 'Send' }).click()
      await page.waitForTimeout(60)
    }
    for (const text of burstMessages) {
      await bridge.command(
        'wait_for_message',
        {
          text,
          timeoutMs: RUN_PRODUCTION_RELAYS ? 70000 : 35000,
          incomingOnly: true,
        },
        RUN_PRODUCTION_RELAYS ? 80000 : 45000
      )
    }
    const lastBurst = burstMessages[burstMessages.length - 1]
    await bridge.command(
      'wait_for_message_ui',
      {
        sessionId: flutterSession.sessionId,
        text: lastBurst,
        timeoutMs: RUN_PRODUCTION_RELAYS ? 70000 : 35000,
        incomingOnly: true,
      },
      RUN_PRODUCTION_RELAYS ? 80000 : 45000
    )

    const roundTrips = RUN_PRODUCTION_RELAYS ? 10 : 4
    for (let i = 1; i <= roundTrips; i++) {
      // Typing rumors only have second-level ordering in the interop path; keep
      // each probe on a fresh Nostr second so the app doesn't classify it as a
      // stale replay of the previous message.
      await waitForNextCreatedAtSecond()
      const webToFlutter = `web->flutter soak #${i} ${Date.now()}`
      await composer.fill(`typing pre-send ${i}`)
      await bridge.command(
        'wait_for_typing',
        { sessionId: flutterSession.sessionId, timeoutMs: 30000, isTyping: true },
        40000
      )
      await page.waitForTimeout(humanPauseMs)
      await composer.fill('')
      await page.getByPlaceholder('Type a message...').fill(webToFlutter)
      await page.getByRole('button', { name: 'Send' }).click()
      await bridge.command(
        'wait_for_message_ui',
        {
          sessionId: flutterSession.sessionId,
          text: webToFlutter,
          timeoutMs: RUN_PRODUCTION_RELAYS ? 60000 : 30000,
          incomingOnly: true,
        },
        RUN_PRODUCTION_RELAYS ? 70000 : 40000
      )
      await page.waitForTimeout(humanPauseMs)

      await bridge.command('send_typing', { sessionId: flutterSession.sessionId }, 30000)
      await page.waitForTimeout(humanPauseMs)
      await bridge.command('send_typing_stopped', { sessionId: flutterSession.sessionId }, 30000)
      await page.waitForTimeout(humanPauseMs)

      const flutterToWeb = `flutter->web soak #${i} ${Date.now()}`
      await bridge.command(
        'send_message_ui',
        { sessionId: flutterSession.sessionId, text: flutterToWeb },
        30000
      )
      await bridge.command(
        'wait_for_message',
        { text: flutterToWeb, timeoutMs: 30000, incomingOnly: false },
        40000
      )
      await expect(
        page.locator('.max-w-\\[85\\%\\]').filter({ hasText: flutterToWeb }).first()
      ).toBeVisible({ timeout: RUN_PRODUCTION_RELAYS ? 60000 : 30000 })
      await page.waitForTimeout(humanPauseMs)
    }

    await bridge.stop()

    bridge = new FlutterInteropBridge(relayUrls, flutterNsec, flutterDataDir, true)
    await bridge.start()
    await bridge.command(
      'wait_for_connected_relays',
      {
        minConnected: RUN_PRODUCTION_RELAYS ? 2 : 1,
        timeoutMs: RUN_PRODUCTION_RELAYS ? 180000 : 30000,
      },
      RUN_PRODUCTION_RELAYS ? 190000 : 40000
    )

    const resumedSession = await bridge.command<{ sessionId: string }>(
      'wait_for_session',
      {
        recipientPubkeyHex: webPubkeyHex,
        timeoutMs: RUN_PRODUCTION_RELAYS ? 90000 : 30000,
      },
      RUN_PRODUCTION_RELAYS ? 100000 : 40000
    )

    const webAfterReopen = `web->flutter post-reopen ${Date.now()}`
    await page.getByPlaceholder('Type a message...').fill(webAfterReopen)
    await page.getByRole('button', { name: 'Send' }).click()
    await bridge.command(
      'wait_for_message_ui',
      {
        sessionId: resumedSession.sessionId,
        text: webAfterReopen,
        timeoutMs: RUN_PRODUCTION_RELAYS ? 60000 : 30000,
        incomingOnly: true,
      },
      RUN_PRODUCTION_RELAYS ? 70000 : 40000
    )

    const flutterAfterReopen = `flutter->web post-reopen ${Date.now()}`
    await bridge.command(
      'send_message_ui',
      { sessionId: resumedSession.sessionId, text: flutterAfterReopen },
      30000
    )
    await bridge.command(
      'wait_for_message',
      { text: flutterAfterReopen, timeoutMs: 30000, incomingOnly: false },
      40000
    )
    await expect(
      page.locator('.max-w-\\[85\\%\\]').filter({ hasText: flutterAfterReopen }).first()
    ).toBeVisible({ timeout: RUN_PRODUCTION_RELAYS ? 60000 : 30000 })
    await silentRelayConnectionsReady
  } finally {
    await context.close()
    if (bridge) {
      await bridge.stop()
    }
    await fsp.rm(flutterDataDir, { recursive: true, force: true }).catch(() => {})
  }
})

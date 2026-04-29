import { test, expect, useTestRelay } from './fixtures'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as readline from 'readline'
import { fileURLToPath } from 'url'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import type { BrowserContext, Page } from '@playwright/test'
import type { TestRelay } from './test-relay'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const NDR_CWD = path.resolve(__dirname, '../../nostr-double-ratchet/rust')
const NDR_BIN = path.join(NDR_CWD, 'target', 'debug', 'ndr')
const NDR_SECRET =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

function skipIfNdrWorkspaceMissing() {
  test.skip(!fs.existsSync(NDR_CWD), `NDR workspace missing: ${NDR_CWD}`)
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
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

async function clearIdentity(context: BrowserContext) {
  await context.addInitScript(() => {
    try {
      window.localStorage.removeItem('iris-chat-identity')
    } catch {
      // ignore opaque origins
    }
  })
}

async function loginWithStoredKey(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible({
    timeout: 30000,
  })
}

async function loginAnonymously(page: Page) {
  await page.goto('/')
  const goButton = page.getByRole('button', { name: 'Go' })
  const newChatButton = page.getByRole('button', { name: 'New Chat' })

  await Promise.race([
    goButton.waitFor({ state: 'visible', timeout: 5000 }).catch(() => null),
    newChatButton.waitFor({ state: 'visible', timeout: 5000 }).catch(() => null),
  ])

  if (await goButton.isVisible().catch(() => false)) {
    await goButton.click()
  }

  await expect(newChatButton).toBeVisible({ timeout: 30000 })
}

async function getStoredIdentityPrivkeyHex(page: Page): Promise<string> {
  const privkeyHex = await page.evaluate(() => localStorage.getItem('iris-chat-identity'))
  if (!privkeyHex) {
    throw new Error('No stored web identity found in localStorage')
  }
  return privkeyHex
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
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (!message.includes('detached') && !message.includes('not stable')) {
      throw error
    }
  }
  await page.getByRole('button', { name: 'Back' }).click()
}

async function waitForNextCreatedAtSecond(): Promise<void> {
  const currentSecond = Math.floor(Date.now() / 1000)
  while (Math.floor(Date.now() / 1000) === currentSecond) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
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
  const composer = page.getByPlaceholder('Type a message...')

  await Promise.race([
    acceptButton.waitFor({ state: 'visible', timeout: 5000 }).catch(() => null),
    composer.waitFor({ state: 'visible', timeout: 5000 }).catch(() => null),
  ])

  if (await acceptButton.isVisible().catch(() => false)) {
    await acceptButton.click()
    await expect(composer).toBeVisible({ timeout: 30000 })
  }
}

async function waitForNdrGroupRefresh(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 750))
}

async function expectChatBubbleVisible(page: Page, text: string): Promise<void> {
  const bubble = page
    .locator('.max-w-\\[85\\%\\]')
    .filter({ hasText: text })
    .first()

  try {
    await expect(bubble).toBeVisible({ timeout: 10_000 })
    return
  } catch {
    await openChatFromList(page, text).catch(() => {})
  }

  await expect(bubble).toBeVisible({ timeout: 30_000 })
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
  await expect(page.getByText('Device linked', { exact: true })).toBeVisible({ timeout: 20000 })
  await page.locator('button[aria-label="Close"]').click()
  await page.getByRole('button', { name: 'Back' }).click()
}

function extractInviteField(inviteUrl: string, field: string): string | null {
  try {
    const hash = new URL(inviteUrl).hash.replace(/^#/, '')
    const decoded = decodeURIComponent(hash)
    const parsed = JSON.parse(decoded) as Record<string, unknown>
    return typeof parsed[field] === 'string' ? parsed[field] : null
  } catch {
    return null
  }
}

async function waitForRelayEvent(
  testRelay: TestRelay,
  predicate: (event: TestRelay['publishedEvents'][number]) => boolean,
  timeoutMs: number,
  description: string
): Promise<TestRelay['publishedEvents'][number]> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const matched = testRelay.publishedEvents.find(predicate)
    if (matched) {
      return matched
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for relay event: ${description}`)
}

async function waitForNewRelayEvent(
  testRelay: TestRelay,
  startIndex: number,
  predicate: (event: TestRelay['publishedEvents'][number]) => boolean,
  timeoutMs: number,
  description: string
): Promise<TestRelay['publishedEvents'][number]> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const matched = testRelay.publishedEvents.slice(startIndex).find(predicate)
    if (matched) {
      return matched
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for new relay event: ${description}`)
}

async function waitForNdrReceiveContent(
  testRelay: TestRelay,
  startIndex: number,
  expectedContent: string,
  dataDir: string,
  timeoutMs: number
): Promise<any> {
  const deadline = Date.now() + timeoutMs
  let nextIndex = startIndex

  while (Date.now() < deadline) {
    const newEvents = testRelay.publishedEvents.slice(nextIndex)
    for (const event of newEvents) {
      nextIndex += 1
      if (event.kind !== 1060) {
        continue
      }

      const received = await runNdrRetry(
        ['receive', JSON.stringify(event)],
        dataDir,
        30000,
        500
      )
      if (received.status === 'ok' && received.command === 'receive' && received.data?.content === expectedContent) {
        return received
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`Timed out waiting for ndr receive content: ${expectedContent}`)
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

function createNdrDataDir(relayUrls: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndr-interop-'))
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ relays: relayUrls })
  )
  return dir
}

let ndrBuildPromise: Promise<void> | null = null

async function ensureNdrBinary(): Promise<void> {
  if (!ndrBuildPromise) {
    ndrBuildPromise = new Promise((resolve, reject) => {
      const child = spawn('cargo', ['build', '-q', '-p', 'ndr'], {
        cwd: NDR_CWD,
        env: { ...process.env, NOSTR_PREFER_LOCAL: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let finished = false
      const timeout = setTimeout(() => {
        if (finished) return
        finished = true
        child.kill('SIGKILL')
        reject(new Error(`ndr build timed out: stdout=${stdout} stderr=${stderr}`))
      }, 300000)

      const finish = (fn: () => void) => {
        if (finished) return
        finished = true
        clearTimeout(timeout)
        fn()
      }

      child.stdout.on('data', (data) => {
        stdout += data.toString()
        if (stdout.length > 50000) {
          stdout = stdout.slice(-50000)
        }
      })
      child.stderr.on('data', (data) => {
        stderr += data.toString()
        if (stderr.length > 50000) {
          stderr = stderr.slice(-50000)
        }
      })

      child.on('error', (error) => {
        finish(() => reject(error))
      })

      child.on('close', (code) => {
        finish(() => {
          if (code !== 0) {
            reject(new Error(`ndr build failed: code=${code} stdout=${stdout} stderr=${stderr}`))
            return
          }

          if (!fs.existsSync(NDR_BIN)) {
            reject(new Error(`ndr build succeeded but binary is missing: ${NDR_BIN}`))
            return
          }

          resolve()
        })
      })
    })
  }

  return ndrBuildPromise
}

async function runNdr(args: string[], dataDir: string): Promise<any> {
  await ensureNdrBinary()
  return new Promise((resolve, reject) => {
    const child = spawn(NDR_BIN, ['--json', '--data-dir', dataDir, ...args], {
      cwd: NDR_CWD,
      env: { ...process.env, NOSTR_PREFER_LOCAL: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let finished = false
    const timeout = setTimeout(() => {
      if (finished) return
      finished = true
      child.kill('SIGKILL')
      reject(new Error(`ndr timed out: args=${args.join(' ')} stdout=${stdout} stderr=${stderr}`))
    }, 60000)

    const finish = (fn: () => void) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      fn()
    }

    child.stdout.on('data', (data) => {
      stdout += data.toString()
      if (stdout.length > 50000) {
        stdout = stdout.slice(-50000)
      }
    })
    child.stderr.on('data', (data) => {
      stderr += data.toString()
      if (stderr.length > 50000) {
        stderr = stderr.slice(-50000)
      }
    })

    child.on('error', (error) => {
      finish(() => reject(error))
    })

    child.on('close', (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(`ndr failed: code=${code} stdout=${stdout} stderr=${stderr}`))
          return
        }

        const lines = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            resolve(JSON.parse(lines[i]))
            return
          } catch {
            // ignore non-json lines
          }
        }

        reject(new Error(`ndr produced no json output: stdout=${stdout} stderr=${stderr}`))
      })
    })
  })
}

async function runNdrRetry(
  args: string[],
  dataDir: string,
  timeoutMs: number,
  intervalMs: number
): Promise<any> {
  const deadline = Date.now() + timeoutMs
  // NDR may race against Iris publishing its public invite on fresh logins.
  // Retry for a bit to avoid flakes.
  while (true) {
    try {
      return await runNdr(args, dataDir)
    } catch (e) {
      if (Date.now() >= deadline) throw e
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  }
}

type NdrListener = {
  child: ReturnType<typeof spawn>
  reader: readline.Interface
  stderrReader: readline.Interface
  recentStdout: string[]
  recentStderr: string[]
}

async function startNdrListen(dataDir: string): Promise<NdrListener> {
  await ensureNdrBinary()
  const child = spawn(NDR_BIN, ['--json', '--data-dir', dataDir, 'listen'], {
    cwd: NDR_CWD,
    env: { ...process.env, NOSTR_PREFER_LOCAL: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const reader = readline.createInterface({ input: child.stdout })
  const stderrReader = readline.createInterface({ input: child.stderr })
  const recentStdout: string[] = []
  const recentStderr: string[] = []

  const rememberLine = (lines: string[], line: string) => {
    lines.push(line)
    if (lines.length > 50) {
      lines.shift()
    }
  }

  reader.on('line', (line) => {
    rememberLine(recentStdout, line)
  })
  stderrReader.on('line', (line) => {
    rememberLine(recentStderr, line)
  })

  return { child, reader, stderrReader, recentStdout, recentStderr }
}

async function waitForNdrListenRunning(
  child: NdrListener['child'],
  startupMs = 500
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      resolve()
    }, startupMs)

    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(
        new Error(`ndr listen exited before startup window: code=${code} signal=${signal}`)
      )
    }

    const cleanup = () => {
      clearTimeout(timeout)
      child.off('close', onClose)
    }

    child.once('close', onClose)
  })
}

async function waitForNdrJson(
  listener: NdrListener,
  predicate: (value: any) => boolean,
  timeoutMs: number,
  description: string
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(
        new Error(
          `Timed out waiting for ndr output: ${description}\n` +
            `Recent stdout:\n${listener.recentStdout.join('\n')}\n` +
            `Recent stderr:\n${listener.recentStderr.join('\n')}`
        )
      )
    }, timeoutMs)

    const onLine = (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let parsed: any
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        return
      }
      if (predicate(parsed)) {
        cleanup()
        resolve(parsed)
      }
    }

    const cleanup = () => {
      clearTimeout(timeout)
      listener.reader.off('line', onLine)
    }

    listener.reader.on('line', onLine)
  })
}

async function stopNdrListen(child: NdrListener['child']) {
  child.kill('SIGINT')
  await new Promise((resolve) => {
    child.on('close', resolve)
  })
}

test('iris-chat <-> ndr interop', async ({ page, silentRelay, testRelay, testRelayUrls }) => {
  skipIfNdrWorkspaceMissing()
  test.setTimeout(240000)

  const dataDir = createNdrDataDir(testRelayUrls)
  let listener: NdrListener | null = null

  try {
    const login = await runNdr(['login', NDR_SECRET], dataDir)
    expect(login.status).toBe('ok')

    const created = await runNdr(['invite', 'create'], dataDir)
    expect(created.status).toBe('ok')
    const inviteUrl: string | undefined = created.data?.url
    expect(inviteUrl).toBeTruthy()

    await useTestRelay(page.context(), testRelayUrls)
    await page.goto('/')
    await page.getByRole('button', { name: 'Go' }).click()

    await page.getByRole('button', { name: 'New Chat' }).click()

    listener = await startNdrListen(dataDir)
    await waitForNdrListenRunning(listener.child)
    const silentRelayConnectionsReady = waitForRelayConnectionCount(silentRelay, 2, 120000)

    const createdSessionPromise = waitForNdrJson(
      listener,
      (json) => json.event === 'session_created' && typeof json.chat_id === 'string',
      60000,
      'session_created after invite acceptance'
    )
    await page.getByPlaceholder('Paste invite link').fill(inviteUrl!)
    const createdSession = await createdSessionPromise
    await stopNdrListen(listener.child)
    listener = null

    const irisMessage = 'hello from iris'
    const relayEventStart = testRelay.publishedEvents.length
    await page.getByPlaceholder('Type a message...').fill(irisMessage)
    await page.getByRole('button', { name: 'Send' }).click()
    await waitForNewRelayEvent(
      testRelay,
      relayEventStart,
      (event) => event.kind === 1060,
      10000,
      'iris sending a 1060 message event'
    )

    const received = await waitForNdrReceiveContent(
      testRelay,
      relayEventStart,
      irisMessage,
      dataDir,
      30000
    )
    expect(received.status).toBe('ok')
    expect(received.command).toBe('receive')
    expect(received.data?.content).toBe(irisMessage)

    const ndrMessage = 'hello from ndr'
    await runNdrRetry(['send', createdSession.chat_id, ndrMessage], dataDir, 30000, 500)

    await expect(
      page.locator('.max-w-\\[85\\%\\]').filter({ hasText: ndrMessage })
    ).toBeVisible({ timeout: 30000 })
    await silentRelayConnectionsReady
  } finally {
    if (listener) {
      await stopNdrListen(listener.child)
    }
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('iris-chat linked devices <-> ndr interop', async ({
  browser,
  silentRelay,
  testRelay,
  testRelayUrls,
}) => {
  skipIfNdrWorkspaceMissing()
  test.setTimeout(300000)

  const ownerSecret = generateSecretKey()
  const ownerPrivkeyHex = toHex(ownerSecret)
  const ownerPubkeyHex = getPublicKey(ownerSecret)

  const ownerContext = await browser.newContext()
  const linkedContext = await browser.newContext()
  await useTestRelay(ownerContext, testRelayUrls)
  await useTestRelay(linkedContext, testRelayUrls)
  await setIdentity(ownerContext, ownerPrivkeyHex)
  await clearIdentity(linkedContext)

  const ownerPage = await ownerContext.newPage()
  const linkedPage = await linkedContext.newPage()

  const dataDir = createNdrDataDir(testRelayUrls)
  let listener: NdrListener | null = null

  try {
    const login = await runNdr(['login', NDR_SECRET], dataDir)
    expect(login.status).toBe('ok')

    await loginWithStoredKey(ownerPage)
    await registerDevice(ownerPage)

    listener = await startNdrListen(dataDir)
    await waitForNdrListenRunning(listener.child)
    const silentRelayConnectionsReady = waitForRelayConnectionCount(silentRelay, 3, 120000)

    const created = await runNdr(['invite', 'create'], dataDir)
    expect(created.status).toBe('ok')
    const inviteUrl: string | undefined = created.data?.url
    expect(inviteUrl).toBeTruthy()

    const createdSessionPromise = waitForNdrJson(
      listener,
      (json) => json.event === 'session_created' && typeof json.chat_id === 'string',
      60000,
      'session_created after invite acceptance'
    )
    await ownerPage.getByRole('button', { name: 'New Chat' }).click()
    await ownerPage.getByPlaceholder('Paste invite link').fill(inviteUrl!)
    await expect(ownerPage.getByPlaceholder('Type a message...')).toBeVisible({
      timeout: 20000,
    })
    const createdSession = await createdSessionPromise

    await openLinkThisDevice(linkedPage)
    const linkInviteUrl = await getLinkInviteUrl(linkedPage)
    const linkedDevicePubkey = extractInviteField(linkInviteUrl, 'inviter')
    expect(linkedDevicePubkey).toBeTruthy()
    await acceptLinkInvite(ownerPage, linkInviteUrl)
    await expect(linkedPage.getByRole('button', { name: 'New Chat' })).toBeVisible({
      timeout: 30000,
    })
    await waitForRelayEvent(
      testRelay,
      (event) =>
        event.kind === 30078 &&
        event.pubkey === ownerPubkeyHex &&
        event.tags.some(
          (tag) => tag[0] === 'device' && tag[1] === linkedDevicePubkey
        ),
      30000,
      'owner AppKeys update authorizing linked device'
    )
    await waitForRelayEvent(
      testRelay,
      (event) =>
        event.pubkey === linkedDevicePubkey &&
        event.tags.some(
          (tag) => tag[0] === 'd' && tag[1] === `double-ratchet/invites/${linkedDevicePubkey}`
        ),
      30000,
      'linked device invite publication after registration'
    )
    await ownerPage
      .getByPlaceholder('Type a message...')
      .fill(`owner warmup draft ${Date.now()}`)

    const ndrWarmup = `ndr warmup ${Date.now()}`
    await runNdrRetry(['send', createdSession.chat_id, ndrWarmup], dataDir, 30000, 500)
    await expectChatBubbleVisible(ownerPage, ndrWarmup)
    await expectChatBubbleVisible(linkedPage, ndrWarmup)
    const linkedAcceptButton = linkedPage.getByRole('button', { name: 'Accept' }).first()
    if (await linkedAcceptButton.isVisible().catch(() => false)) {
      await linkedAcceptButton.click()
      await expect(linkedPage.getByPlaceholder('Type a message...')).toBeVisible({
        timeout: 30000,
      })
    }

    const ndrToAll = `ndr->owner+linked ${Date.now()}`
    await runNdrRetry(['send', createdSession.chat_id, ndrToAll], dataDir, 30000, 500)
    await expectChatBubbleVisible(ownerPage, ndrToAll)
    await expectChatBubbleVisible(linkedPage, ndrToAll)
    await silentRelayConnectionsReady
  } finally {
    if (listener) {
      await stopNdrListen(listener.child)
    }
    await ownerContext.close()
    await linkedContext.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('iris-chat group <-> ndr interop (web creates group)', async ({
  page,
  silentRelay,
  testRelayUrls,
}) => {
  skipIfNdrWorkspaceMissing()
  test.setTimeout(240000)

  const dataDir = createNdrDataDir(testRelayUrls)
  let listener: NdrListener | null = null

  try {
    const login = await runNdr(['login', NDR_SECRET], dataDir)
    expect(login.status).toBe('ok')

    const invite = await runNdr(['invite', 'create'], dataDir)
    expect(invite.status).toBe('ok')

    await useTestRelay(page.context(), testRelayUrls)
    await loginAnonymously(page)

    listener = await startNdrListen(dataDir)
    await waitForNdrListenRunning(listener.child)
    const silentRelayConnectionsReady = waitForRelayConnectionCount(silentRelay, 2, 120000)

    const createdSessionPromise = waitForNdrJson(
      listener,
      (json) => json.event === 'session_created' && typeof json.chat_id === 'string',
      60000,
      'session_created after web accepts ndr invite for group bootstrap'
    )

    await page.getByRole('button', { name: 'New Chat' }).click()
    await page.getByPlaceholder('Paste invite link').fill(invite.data?.url)
    const createdSession = await createdSessionPromise

    const bootstrapAck = `ndr group bootstrap ack ${Date.now()}`
    await runNdrRetry(['send', createdSession.chat_id, bootstrapAck], dataDir, 30000, 500)
    await expectChatBubbleVisible(page, bootstrapAck)

    await page.getByRole('button', { name: 'Back' }).click()
    await expect(page.getByRole('button', { name: 'Create Group' })).toBeVisible({
      timeout: 20000,
    })

    const groupName = `web-to-ndr-group-${Date.now()}`
    const groupMetadataPromise = waitForNdrJson(
      listener,
      (json) =>
        json.event === 'group_metadata' &&
        json.action === 'created' &&
        json.name === groupName &&
        typeof json.group_id === 'string',
      60000,
      'ndr receiving created group metadata from web'
    )

    await page.getByRole('button', { name: 'Create Group' }).click()
    const createGroupView = page.getByTestId('create-group-view')
    await createGroupView.getByTestId('create-group-member').first().click()
    await createGroupView.getByTestId('create-group-next').click()
    await page.getByPlaceholder('Enter group name...').fill(groupName)
    await createGroupView.getByTestId('create-group-submit').click()

    const createdGroup = await groupMetadataPromise
    const groupId = createdGroup.group_id as string

    const accepted = await runNdrRetry(['group', 'accept', groupId], dataDir, 30000, 500)
    expect(accepted.status).toBe('ok')
    await waitForNdrGroupRefresh()

    const ndrMessageOne = `ndr->web group 1 ${Date.now()}`
    await runNdrRetry(['group', 'send', groupId, ndrMessageOne], dataDir, 30000, 500)
    await expectChatBubbleVisible(page, ndrMessageOne)

    const ndrMessageTwo = `ndr->web group 2 ${Date.now()}`
    await runNdrRetry(['group', 'send', groupId, ndrMessageTwo], dataDir, 30000, 500)
    await expectChatBubbleVisible(page, ndrMessageTwo)

    const webMessageOne = `web->ndr group 1 ${Date.now()}`
    await page.getByPlaceholder('Type a message...').fill(webMessageOne)
    await page.getByRole('button', { name: 'Send' }).click()

    await waitForNdrJson(
      listener,
      (json) =>
        json.event === 'group_message' &&
        json.group_id === groupId &&
        json.content === webMessageOne,
      60000,
      'ndr receiving first web group message'
    )

    const webMessageTwo = `web->ndr group 2 ${Date.now()}`
    await page.getByPlaceholder('Type a message...').fill(webMessageTwo)
    await page.getByRole('button', { name: 'Send' }).click()

    await waitForNdrJson(
      listener,
      (json) =>
        json.event === 'group_message' &&
        json.group_id === groupId &&
        json.content === webMessageTwo,
      60000,
      'ndr receiving second web group message'
    )
    await silentRelayConnectionsReady
  } finally {
    if (listener) {
      await stopNdrListen(listener.child)
    }
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('iris-chat group <-> ndr interop (ndr creates group)', async ({
  page,
  silentRelay,
  testRelayUrls,
}) => {
  skipIfNdrWorkspaceMissing()
  test.setTimeout(240000)

  const dataDir = createNdrDataDir(testRelayUrls)
  let listener: NdrListener | null = null

  try {
    const login = await runNdr(['login', NDR_SECRET], dataDir)
    expect(login.status).toBe('ok')

    await useTestRelay(page.context(), testRelayUrls)
    await loginAnonymously(page)
    const webPrivkeyHex = await getStoredIdentityPrivkeyHex(page)
    const webPubkeyHex = getPublicKey(Buffer.from(webPrivkeyHex, 'hex')).toLowerCase()

    listener = await startNdrListen(dataDir)
    await waitForNdrListenRunning(listener.child)
    const silentRelayConnectionsReady = waitForRelayConnectionCount(silentRelay, 2, 120000)

    const invite = await runNdr(['invite', 'create'], dataDir)
    expect(invite.status).toBe('ok')

    const createdSessionPromise = waitForNdrJson(
      listener,
      (json) => json.event === 'session_created' && typeof json.chat_id === 'string',
      60000,
      'session_created after web accepts ndr invite for ndr-created group bootstrap'
    )

    await page.getByRole('button', { name: 'New Chat' }).click()
    await page.getByPlaceholder('Paste invite link').fill(invite.data?.url)
    const createdSession = await createdSessionPromise

    const bootstrapAck = `ndr created-group bootstrap ack ${Date.now()}`
    await runNdrRetry(['send', createdSession.chat_id, bootstrapAck], dataDir, 30000, 500)
    await expectChatBubbleVisible(page, bootstrapAck)

    const groupName = `ndr-to-web-group-${Date.now()}`
    const createdGroup = await runNdrRetry(
      ['group', 'create', '--name', groupName, '--members', webPubkeyHex],
      dataDir,
      30000,
      500
    )
    expect(createdGroup.status).toBe('ok')
    const groupId = createdGroup.data?.id as string
    expect(groupId).toBeTruthy()
    await waitForNdrGroupRefresh()

    await openGroupFromSidebar(page, groupName)
    await acceptOpenGroupIfNeeded(page)

    const ndrMessageOne = `ndr->web created group 1 ${Date.now()}`
    await runNdrRetry(['group', 'send', groupId, ndrMessageOne], dataDir, 30000, 500)
    await expectChatBubbleVisible(page, ndrMessageOne)

    const ndrMessageTwo = `ndr->web created group 2 ${Date.now()}`
    await runNdrRetry(['group', 'send', groupId, ndrMessageTwo], dataDir, 30000, 500)
    await expectChatBubbleVisible(page, ndrMessageTwo)

    const webMessageOne = `web->ndr created group 1 ${Date.now()}`
    await page.getByPlaceholder('Type a message...').fill(webMessageOne)
    await page.getByRole('button', { name: 'Send' }).click()

    await waitForNdrJson(
      listener,
      (json) =>
        json.event === 'group_message' &&
        json.group_id === groupId &&
        json.content === webMessageOne,
      60000,
      'ndr receiving first web message in ndr-created group'
    )

    const webMessageTwo = `web->ndr created group 2 ${Date.now()}`
    await page.getByPlaceholder('Type a message...').fill(webMessageTwo)
    await page.getByRole('button', { name: 'Send' }).click()

    await waitForNdrJson(
      listener,
      (json) =>
        json.event === 'group_message' &&
        json.group_id === groupId &&
        json.content === webMessageTwo,
      60000,
      'ndr receiving second web message in ndr-created group'
    )
    await silentRelayConnectionsReady
  } finally {
    if (listener) {
      await stopNdrListen(listener.child)
    }
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

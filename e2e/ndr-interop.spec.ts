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
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (testRelay.publishedEvents.some(predicate)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for relay event: ${description}`)
}

function createNdrDataDir(relayUrl: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndr-interop-'))
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ relays: [relayUrl] })
  )
  return dir
}

async function runNdr(args: string[], dataDir: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'cargo',
      [
        'run',
        '-q',
        '-p',
        'ndr',
        '--',
        '--json',
        '--data-dir',
        dataDir,
        ...args,
      ],
      {
        cwd: NDR_CWD,
        env: { ...process.env, NOSTR_PREFER_LOCAL: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )

    let stdout = ''
    let stderr = ''
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

    child.on('close', (code) => {
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

function startNdrListen(dataDir: string) {
  const child = spawn(
    'cargo',
    ['run', '-q', '-p', 'ndr', '--', '--json', '--data-dir', dataDir, 'listen'],
    {
      cwd: NDR_CWD,
      env: { ...process.env, NOSTR_PREFER_LOCAL: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )

  const reader = readline.createInterface({ input: child.stdout })
  return { child, reader }
}

async function waitForNdrListenRunning(
  child: ReturnType<typeof startNdrListen>['child'],
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
  reader: readline.Interface,
  predicate: (value: any) => boolean,
  timeoutMs: number,
  description: string
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ndr output: ${description}`))
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
      reader.off('line', onLine)
    }

    reader.on('line', onLine)
  })
}

async function stopNdrListen(child: ReturnType<typeof startNdrListen>['child']) {
  child.kill('SIGINT')
  await new Promise((resolve) => {
    child.on('close', resolve)
  })
}

test('iris-chat <-> ndr interop', async ({ page, testRelayUrl }) => {
  skipIfNdrWorkspaceMissing()
  test.setTimeout(240000)

  const dataDir = createNdrDataDir(testRelayUrl)
  let listener: ReturnType<typeof startNdrListen> | null = null

  try {
    const login = await runNdr(['login', NDR_SECRET], dataDir)
    expect(login.status).toBe('ok')

    const created = await runNdr(['invite', 'create'], dataDir)
    expect(created.status).toBe('ok')
    const inviteUrl: string | undefined = created.data?.url
    expect(inviteUrl).toBeTruthy()

    await page.goto('/')
    await page.getByRole('button', { name: 'Go' }).click()

    await page.getByRole('button', { name: 'New Chat' }).click()

    listener = startNdrListen(dataDir)
    await waitForNdrListenRunning(listener.child)

    const createdSessionPromise = waitForNdrJson(
      listener.reader,
      (json) => json.event === 'session_created' && typeof json.chat_id === 'string',
      60000,
      'session_created after invite acceptance'
    )
    await page.getByPlaceholder('Paste invite link').fill(inviteUrl!)
    const createdSession = await createdSessionPromise

    const irisMessage = 'hello from iris'
    const irisMessagePromise = waitForNdrJson(
      listener.reader,
      (json) => json.event === 'message' && json.content === irisMessage,
      30000,
      'ndr receiving iris message'
    )
    await page.getByPlaceholder('Type a message...').fill(irisMessage)
    await page.getByRole('button', { name: 'Send' }).click()

    await irisMessagePromise

    const ndrMessage = 'hello from ndr'
    await runNdrRetry(['send', createdSession.chat_id, ndrMessage], dataDir, 30000, 500)

    await expect(
      page.locator('.max-w-\\[85\\%\\]').filter({ hasText: ndrMessage })
    ).toBeVisible({ timeout: 30000 })
  } finally {
    if (listener) {
      await stopNdrListen(listener.child)
    }
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('iris-chat linked devices <-> ndr interop', async ({ browser, testRelayUrl, testRelay }) => {
  skipIfNdrWorkspaceMissing()
  test.setTimeout(300000)

  const ownerSecret = generateSecretKey()
  const ownerPrivkeyHex = toHex(ownerSecret)
  const ownerPubkeyHex = getPublicKey(ownerSecret)

  const ownerContext = await browser.newContext()
  const linkedContext = await browser.newContext()
  await useTestRelay(ownerContext, testRelayUrl)
  await useTestRelay(linkedContext, testRelayUrl)
  await setIdentity(ownerContext, ownerPrivkeyHex)
  await clearIdentity(linkedContext)

  const ownerPage = await ownerContext.newPage()
  const linkedPage = await linkedContext.newPage()

  const dataDir = createNdrDataDir(testRelayUrl)
  let listener: ReturnType<typeof startNdrListen> | null = null

  try {
    const login = await runNdr(['login', NDR_SECRET], dataDir)
    expect(login.status).toBe('ok')

    await loginWithStoredKey(ownerPage)
    await registerDevice(ownerPage)

    listener = startNdrListen(dataDir)
    await waitForNdrListenRunning(listener.child)

    const created = await runNdr(['invite', 'create'], dataDir)
    expect(created.status).toBe('ok')
    const inviteUrl: string | undefined = created.data?.url
    expect(inviteUrl).toBeTruthy()

    const createdSessionPromise = waitForNdrJson(
      listener.reader,
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
    const ownerToAll = `owner->ndr+linked ${Date.now()}`
    const ownerToNdrPromise = waitForNdrJson(
      listener.reader,
      (json) => json.event === 'message' && json.content === ownerToAll,
      30000,
      'ndr receiving owner message after linking'
    )
    await ownerPage.getByPlaceholder('Type a message...').fill(ownerToAll)
    await ownerPage.getByRole('button', { name: 'Send' }).click()
    await ownerToNdrPromise
    await openChatFromList(linkedPage, ownerToAll)
    await expect(
      linkedPage.locator('.max-w-\\[85\\%\\]').filter({ hasText: ownerToAll }).first()
    ).toBeVisible({ timeout: 30000 })

    const linkedToAll = `linked->owner+ndr ${Date.now()}`
    const linkedToNdrPromise = waitForNdrJson(
      listener.reader,
      (json) => json.event === 'message' && json.content === linkedToAll,
      30000,
      'ndr receiving linked-device message'
    )
    await linkedPage.getByPlaceholder('Type a message...').fill(linkedToAll)
    await linkedPage.getByRole('button', { name: 'Send' }).click()
    await linkedToNdrPromise
    await expect(
      ownerPage.locator('.max-w-\\[85\\%\\]').filter({ hasText: linkedToAll }).first()
    ).toBeVisible({ timeout: 30000 })

    // Only assert reverse fanout from ndr after the linked web sibling has
    // demonstrated it has an active direct session with ndr as well.
    const ndrToAll = `ndr->owner+linked ${Date.now()}`
    await runNdrRetry(['send', createdSession.chat_id, ndrToAll], dataDir, 30000, 500)
    await expect(
      ownerPage.locator('.max-w-\\[85\\%\\]').filter({ hasText: ndrToAll }).first()
    ).toBeVisible({ timeout: 30000 })
    await expect(
      linkedPage.locator('.max-w-\\[85\\%\\]').filter({ hasText: ndrToAll }).first()
    ).toBeVisible({ timeout: 30000 })
  } finally {
    if (listener) {
      await stopNdrListen(listener.child)
    }
    await ownerContext.close()
    await linkedContext.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

import { test, expect } from '@playwright/test'
import { spawnSync } from 'child_process'
import { generateSecretKey, nip19 } from 'nostr-tools'

const PUBLIC_INTEROP_RELAYS = [
  'wss://temp.iris.to',
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
]
const WEB_BASE_URL = process.env.IRIS_CHAT_INTEROP_WEB_BASE_URL ?? '/'
const RELAY_URLS = (process.env.IRIS_CHAT_RS_INTEROP_RELAY_URLS ?? process.env.IRIS_CHAT_RS_INTEROP_RELAY_URL ?? PUBLIC_INTEROP_RELAYS.join(','))
  .split(',')
  .map((relay) => relay.trim())
  .filter(Boolean)
const ADB = process.env.IRIS_CHAT_RS_ADB ?? 'adb'
const SERIAL = process.env.IRIS_CHAT_RS_ANDROID_SERIAL ?? ''
const HARNESS = '/Users/sirius/src/iris-chat-rs/scripts/run_harness.py'
const RUNNER = 'to.iris.chat.test/androidx.test.runner.AndroidJUnitRunner'
const CLASS_NAME = 'to.iris.chat.RealRelayHarnessTest'

test.describe.configure({ mode: 'serial' })

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function configureWebIdentity(context: import('@playwright/test').BrowserContext) {
  const identity = toHex(generateSecretKey())
  await context.addInitScript(
    ({ relayUrls, identityKey }) => {
      localStorage.setItem('iris-chat-relays', JSON.stringify(relayUrls))
      localStorage.setItem('iris-chat-identity', identityKey)
    },
    { relayUrls: RELAY_URLS, identityKey: identity }
  )
}

async function login(page: import('@playwright/test').Page) {
  await page.goto(WEB_BASE_URL)
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
  await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible({
    timeout: 30000,
  })
}

async function registerDevice(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('heading', { name: 'Devices' }).waitFor({ state: 'visible', timeout: 30000 })
  const registerButton = page.getByRole('button', { name: 'Register this device' })
  const hasRegisteredDevice = async () => (await page.locator('body').innerText()).includes('This device')
  await Promise.race([
    registerButton.waitFor({ state: 'visible', timeout: 30000 }),
    expect.poll(hasRegisteredDevice, { timeout: 30000 }).toBe(true),
  ])
  if (await registerButton.isVisible().catch(() => false)) {
    const registeringButton = page.getByRole('button', { name: /^Registering/ })
    for (let attempt = 0; attempt < 3; attempt++) {
      await registerButton.click()
      await page.waitForTimeout(1000)
      if (
        await hasRegisteredDevice() ||
        await registeringButton.isVisible().catch(() => false)
      ) {
        break
      }
    }
    await expect(registeringButton).not.toBeVisible({
      timeout: 120000,
    })
  }
  await expect.poll(hasRegisteredDevice, { timeout: 90000 }).toBe(true)
  await page.getByRole('button', { name: 'Back' }).click()
}

async function openNewChat(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'New Chat' }).click()
  await expect(page.getByRole('heading', { name: 'New Chat' })).toBeVisible({
    timeout: 30000,
  })
}

async function getInviteUrl(page: import('@playwright/test').Page): Promise<string> {
  const copyButton = page.locator('button[title*="#"]').first()
  await expect(copyButton).toBeVisible({ timeout: 30000 })
  const inviteUrl = await copyButton.getAttribute('title')
  if (!inviteUrl) {
    throw new Error('Invite copy button did not expose a title URL')
  }
  return inviteUrl
}

function runAndroidHarness(inviteUrl: string, message: string) {
  return runAndroidHarnessTest('accept_invite_and_send_message_from_args', [
    `invite_url=${inviteUrl}`,
    `expected_chat_id=${inviteOwnerChatId(inviteUrl)}`,
    `message=${message}`,
  ])
}

function inviteOwnerChatId(inviteUrl: string): string {
  const rawHash = decodeURIComponent(new URL(inviteUrl).hash.slice(1)).replace(/^\/+/, '')
  if (rawHash.startsWith('npub') || rawHash.startsWith('nprofile')) {
    const decoded = nip19.decode(rawHash)
    if (decoded.type === 'npub') {
      return decoded.data
    }
    if (decoded.type === 'nprofile') {
      return decoded.data.pubkey
    }
  }

  const data = JSON.parse(rawHash) as {
    inviter?: string
    owner?: string
    ownerPubkey?: string
  }
  const chatId = data.owner ?? data.ownerPubkey ?? data.inviter
  if (!chatId) {
    throw new Error(`Invite URL did not include an owner or inviter: ${inviteUrl}`)
  }
  return chatId
}

function runAndroidHarnessTest(testName: string, harnessArgs: string[] = []) {
  const command = [
    HARNESS,
    '--adb',
    ADB,
    '--runner',
    RUNNER,
    '--class-name',
    CLASS_NAME,
    '--test-name',
    testName,
  ]
  for (const arg of harnessArgs) {
    command.push('--arg', arg)
  }
  if (SERIAL) {
    command.splice(1, 0, '--serial', SERIAL)
  }

  const result = spawnSync('python3', command, {
    encoding: 'utf8',
    timeout: 240000,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (
    result.status !== 0 ||
    !output.includes('INSTRUMENTATION_CODE: -1') ||
    /FAILURES!!!|INSTRUMENTATION_STATUS_CODE: -\d+/.test(output)
  ) {
    throw new Error(`Android harness failed:\n${output}`)
  }
  if (/INSTRUMENTATION_RESULT: shortMsg=|INSTRUMENTATION_FAILED:/.test(output)) {
    throw new Error(`Android instrumentation crashed:\n${output}`)
  }
  return output
}

function instrumentationStatus(output: string, key: string): string {
  const match = output.match(new RegExp(`INSTRUMENTATION_STATUS: ${key}=([^\\n\\r]+)`))
  if (!match) {
    throw new Error(`Missing instrumentation status ${key} in output:\n${output}`)
  }
  return match[1].trim()
}

function createAndroidInvite(): string {
  const output = runAndroidHarnessTest('create_public_invite_and_report_url')
  return instrumentationStatus(output, 'invite_url')
}

function waitForAndroidMessage(message: string) {
  const output = runAndroidHarnessTest('wait_for_message_from_args', [
    `message=${message}`,
    'direction=incoming',
    'expected_count=1',
  ])
  expect(output).toContain(`INSTRUMENTATION_STATUS: message=${message}`)
  expect(output).toContain('INSTRUMENTATION_STATUS: matching_count=1')
}

async function expectIncomingWebMessage(page: import('@playwright/test').Page, message: string) {
  const bubble = page.locator('.max-w-\\[85\\%\\]').filter({ hasText: message }).first()
  const chatList = page.getByTestId('sidebar-chat-list')
  const requestsTab = page.getByTestId('sidebar-tab-requests')
  const allTab = page.getByTestId('sidebar-tab-all')
  const deadline = Date.now() + 60000

  while (Date.now() < deadline) {
    if (await bubble.isVisible().catch(() => false)) {
      return
    }
    for (const tab of [requestsTab, allTab]) {
      await tab.click().catch(() => {})
      const item = chatList.locator('button').filter({ hasText: message }).first()
      if (await item.isVisible().catch(() => false)) {
        await item.click()
        await expect(bubble).toBeVisible({ timeout: 30000 })
        return
      }
    }
    await page.waitForTimeout(500)
  }

  throw new Error(`Timed out waiting for web to receive Android message: ${message}`)
}

test('iris-chat-rs Android accepts iris-chat web invite and sends message', async ({ page }) => {
  test.setTimeout(300000)

  await configureWebIdentity(page.context())
  await login(page)
  await registerDevice(page)
  await openNewChat(page)

  const inviteUrl = await getInviteUrl(page)
  const message = `android->web ${Date.now()}`
  const output = runAndroidHarness(inviteUrl, message)
  expect(output).toContain('INSTRUMENTATION_STATUS: delivery=')

  await expectIncomingWebMessage(page, message)
})

test('iris-chat web accepts iris-chat-rs Android invite and sends message', async ({ page }) => {
  test.setTimeout(300000)

  await configureWebIdentity(page.context())
  await login(page)
  await registerDevice(page)

  const inviteUrl = createAndroidInvite()
  await openNewChat(page)
  await page.getByPlaceholder('Paste invite link').fill(inviteUrl)
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 60000 })

  const message = `web->android ${Date.now()}`
  await page.getByPlaceholder('Type a message...').fill(message)
  await page.getByRole('button', { name: 'Send' }).click()

  waitForAndroidMessage(message)
})

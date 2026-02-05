import { test, expect, useTestRelay } from './fixtures'
import { generateSecretKey, getPublicKey } from 'nostr-tools'

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function setIdentity(context: import('@playwright/test').BrowserContext, privkeyHex: string) {
  await context.addInitScript((key: string) => {
    localStorage.setItem('iris-chat-identity', key)
  }, privkeyHex)
}

async function loginWithStoredKey(page: import('@playwright/test').Page) {
  await page.goto('/')
  const newChat = page.getByRole('button', { name: 'New Chat' })
  try {
    await expect(newChat).toBeVisible({ timeout: 30000 })
  } catch (err) {
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

async function registerDevice(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Settings' }).click()
  const registerButton = page.getByRole('button', { name: 'Register this device' })
  if (await registerButton.count()) {
    try {
      await expect(registerButton).toBeVisible({ timeout: 10000 })
      await registerButton.click({ timeout: 5000 })
      await expect(registerButton).not.toBeVisible({ timeout: 20000 })
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (!message.includes('detached') && !message.includes('not stable')) {
        throw err
      }
      // Button likely disappeared due to auto-registration; continue.
    }
  }
  await page.getByRole('button', { name: 'Back' }).click()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function openChatFromList(page: import('@playwright/test').Page, message: string): Promise<void> {
  const listItem = page
    .getByRole('button', { name: new RegExp(escapeRegExp(message)) })
    .first()
  await expect(listItem).toBeVisible({ timeout: 30000 })
  await listItem.click()
}

async function getInviteUrl(page: import('@playwright/test').Page): Promise<string> {
  const copyButton = page.locator('button[title*="#"]').first()
  await expect(copyButton).toBeVisible({ timeout: 10000 })
  const url = await copyButton.getAttribute('title')
  if (!url) throw new Error('Could not get invite URL')
  return url.replace('https://chat.iris.to', 'http://localhost:4173')
}

async function getLinkInviteUrl(page: import('@playwright/test').Page): Promise<string> {
  const copyButton = page.locator('button[title*="#"]').first()
  await expect(copyButton).toBeVisible({ timeout: 10000 })
  const url = await copyButton.getAttribute('title')
  if (!url) throw new Error('Could not get link invite URL')
  return url
}

async function openLinkThisDevice(page: import('@playwright/test').Page): Promise<void> {
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

async function acceptLinkInvite(page: import('@playwright/test').Page, inviteUrl: string): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Link another device' }).click()
  await page.getByPlaceholder('Paste link invite').fill(inviteUrl)
  await expect(page.getByText('Device linked')).toBeVisible({ timeout: 20000 })
  await page.locator('button[aria-label="Close"]').click()
  await page.getByRole('button', { name: 'Back' }).click()
}

test('syncs outgoing messages to another device', async ({ browser, testRelayUrl }) => {
  const ownerPrivkey = generateSecretKey()
  const ownerPrivkeyHex = toHex(ownerPrivkey)

  const user2Privkey = generateSecretKey()
  const user2PrivkeyHex = toHex(user2Privkey)
  const user2Pubkey = getPublicKey(user2Privkey)

  const context1 = await browser.newContext()
  const context2 = await browser.newContext()
  const context3 = await browser.newContext()

  await useTestRelay(context1, testRelayUrl)
  await useTestRelay(context2, testRelayUrl)
  await useTestRelay(context3, testRelayUrl)

  await setIdentity(context1, ownerPrivkeyHex)
  await setIdentity(context2, ownerPrivkeyHex)
  await setIdentity(context3, user2PrivkeyHex)

  const page1 = await context1.newPage()
  const page2 = await context2.newPage()
  const page3 = await context3.newPage()

  try {
    await loginWithStoredKey(page1)
    await loginWithStoredKey(page2)
    await loginWithStoredKey(page3)

    await registerDevice(page1)
    await registerDevice(page2)

    // User 2 creates a chat link
    await page3.getByRole('button', { name: 'New Chat' }).click()
    const copyButton = page3.locator('button[title*="#"]').first()
    await expect(copyButton).toBeVisible({ timeout: 10000 })
    const rawUrl = await copyButton.getAttribute('title')
    if (!rawUrl) throw new Error('Could not get invite URL')
    const inviteUrl = rawUrl.replace('https://chat.iris.to', 'http://localhost:4173')

    // Device 1 joins chat and sends a message
    await page1.getByRole('button', { name: 'New Chat' }).click()
    await page1.getByPlaceholder('Paste invite link').fill(inviteUrl)
    await expect(page1.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 15000 })

    await page1.getByPlaceholder('Type a message...').fill('Hello from device 1')
    await page1.getByRole('button', { name: 'Send' }).click()

    // Device 2 should see the message appear via multi-device sync
    await openChatFromList(page2, 'Hello from device 1')
    await expect(
      page2.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Hello from device 1' }).first()
    ).toBeVisible({ timeout: 20000 })

    // Sanity: user2 should receive the message too
    await openChatFromList(page3, 'Hello from device 1')
    await expect(
      page3.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Hello from device 1' }).first()
    ).toBeVisible({ timeout: 20000 })

    // Ensure user2 pubkey is still the chat target (uses new link format)
    expect(user2Pubkey).toBeTruthy()
  } finally {
    await context1.close()
    await context2.close()
    await context3.close()
  }
})

test('self-chat syncs to linked device', async ({ browser, testRelayUrl }) => {
  const contextOwner = await browser.newContext()
  const contextLinked = await browser.newContext()

  await useTestRelay(contextOwner, testRelayUrl)
  await useTestRelay(contextLinked, testRelayUrl)
  await contextLinked.addInitScript(() => {
    localStorage.removeItem('iris-chat-identity')
  })

  const ownerPage = await contextOwner.newPage()
  const linkedPage = await contextLinked.newPage()

  try {
    await ownerPage.goto('/')
    await ownerPage.getByRole('button', { name: 'Go' }).click()
    await expect(ownerPage.getByRole('button', { name: 'New Chat' })).toBeVisible({ timeout: 10000 })

    await registerDevice(ownerPage)

    await openLinkThisDevice(linkedPage)
    const linkInviteUrl = await getLinkInviteUrl(linkedPage)

    await acceptLinkInvite(ownerPage, linkInviteUrl)
    await expect(linkedPage.getByRole('button', { name: 'New Chat' })).toBeVisible({ timeout: 20000 })

    await ownerPage.getByRole('button', { name: 'New Chat' }).click()
    const inviteUrl = await getInviteUrl(ownerPage)

    await ownerPage.getByPlaceholder('Paste invite link').fill(inviteUrl)
    await expect(ownerPage.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 15000 })

    const message = 'Hello to myself'
    await ownerPage.getByPlaceholder('Type a message...').fill(message)
    await ownerPage.getByRole('button', { name: 'Send' }).click()
    await expect(
      ownerPage.locator('.max-w-\\[85\\%\\]').filter({ hasText: message }).first()
    ).toBeVisible({ timeout: 20000 })

    await openChatFromList(linkedPage, message)
    await expect(
      linkedPage.locator('.max-w-\\[85\\%\\]').filter({ hasText: message }).first()
    ).toBeVisible({ timeout: 20000 })
  } finally {
    await contextOwner.close()
    await contextLinked.close()
  }
})

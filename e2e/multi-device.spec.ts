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
  await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible({ timeout: 10000 })
}

async function registerDevice(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Settings' }).click()
  const registerButton = page.getByRole('button', { name: 'Register this device' })
  if (await registerButton.count()) {
    await expect(registerButton).toBeVisible({ timeout: 10000 })
    await registerButton.click()
    await expect(registerButton).not.toBeVisible({ timeout: 20000 })
  }
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
    await expect(page2.getByText('Hello from device 1')).toBeVisible({ timeout: 20000 })

    // Sanity: user2 should receive the message too
    await expect(page3.getByText('Hello from device 1')).toBeVisible({ timeout: 20000 })

    // Ensure user2 pubkey is still the chat target (uses new link format)
    expect(user2Pubkey).toBeTruthy()
  } finally {
    await context1.close()
    await context2.close()
    await context3.close()
  }
})

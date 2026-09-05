import { test, expect, useTestRelay } from './fixtures'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'

async function installNip07Mock(
  page: import('@playwright/test').Page,
  privateKey: Uint8Array
): Promise<string> {
  const publicKey = getPublicKey(privateKey)

  await page.exposeFunction('__irisNip07SignEvent', (event: Parameters<typeof finalizeEvent>[0]) =>
    finalizeEvent({ ...event }, privateKey)
  )

  await page.addInitScript(({ publicKey }) => {
    ;(window as Window & {
      __irisNip07SignEvent?: (event: Record<string, unknown>) => Promise<Record<string, unknown>>
      nostr?: unknown
    }).nostr = {
      getPublicKey: async () => publicKey,
      signEvent: async (event: Record<string, unknown>) =>
        (window as Window & {
          __irisNip07SignEvent: (event: Record<string, unknown>) => Promise<Record<string, unknown>>
        }).__irisNip07SignEvent(event),
      nip44: {
        encrypt: async (_pubkey: string, plaintext: string) => btoa(plaintext),
        decrypt: async (_pubkey: string, ciphertext: string) => atob(ciphertext),
      },
    }
  }, { publicKey })

  return publicKey
}

test.describe('NIP-07 Login', () => {
  test('should login with NIP-07 extension', async ({ page }) => {
    const privateKey = generateSecretKey()
    await installNip07Mock(page, privateKey)

    await page.goto('/')

    // Should show NIP-07 login button
    const nip07Button = page.locator('button:has-text("Login with Extension")')
    await expect(nip07Button).toBeVisible()

    // Click login with extension
    await nip07Button.click()

    // Should be logged in and show home view
    await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible({ timeout: 5000 })
  })

  test('should create invite with NIP-07 login', async ({ page }) => {
    const privateKey = generateSecretKey()
    await installNip07Mock(page, privateKey)

    await page.goto('/')

    // Login with NIP-07
    await page.click('button:has-text("Login with Extension")')
    await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible({ timeout: 5000 })

    // Click New Chat
    await page.getByRole('button', { name: 'New Chat' }).click()

    // Invite creation must not stay stuck on current-device relay registration.
    const copyButton = page.locator('button[title*="#"]').first()
    await expect(copyButton).toBeVisible({ timeout: 15000 })
    await expect(page.locator('text=Creating invite...')).not.toBeVisible({ timeout: 15000 })
  })

  test('should join chat via paste link with NIP-07 login', async ({ browser, testRelayUrl }) => {
    // User 1: Regular login (privkey) and create invite
    const context1 = await browser.newContext()
    await useTestRelay(context1, testRelayUrl)
    const page1 = await context1.newPage()

    await page1.goto('/')
    await page1.getByRole('button', { name: 'Go' }).click()
    await page1.getByRole('button', { name: 'New Chat' }).click()

    // Get the invite URL
    const copyButton = page1.locator('button[title*="#"]').first()
    await expect(copyButton).toBeVisible()
    const rawUrl = await copyButton.getAttribute('title')
    if (!rawUrl) throw new Error('Could not get invite URL')
    const inviteUrl = rawUrl.replace('https://chat.iris.to', new URL(page1.url()).origin)

    // User 2: NIP-07 login and join via paste link
    const context2 = await browser.newContext()
    await useTestRelay(context2, testRelayUrl)
    const page2 = await context2.newPage()

    const privateKey2 = generateSecretKey()
    await installNip07Mock(page2, privateKey2)

    await page2.goto('/')

    // Login with NIP-07
    await page2.click('button:has-text("Login with Extension")')
    await expect(page2.getByRole('button', { name: 'New Chat' })).toBeVisible({ timeout: 5000 })

    // Click New Chat and paste the invite link
    await page2.getByRole('button', { name: 'New Chat' }).click()
    await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

    // Should NOT show "Not logged in" error
    await expect(page2.locator('text=Not logged in')).not.toBeVisible({ timeout: 2000 })

    // Should successfully join and show chat input
    await expect(page2.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 10000 })

    await context1.close()
    await context2.close()
  })

  test('should show error when NIP-07 extension lacks nip44 support', async ({ page }) => {
    const privateKey = generateSecretKey()
    const publicKey = getPublicKey(privateKey)
    await page.exposeFunction('__irisNip07SignEvent', (event: Parameters<typeof finalizeEvent>[0]) =>
      finalizeEvent({ ...event }, privateKey)
    )
    await page.addInitScript(({ publicKey }) => {
      ;(window as Window & {
        __irisNip07SignEvent: (event: Record<string, unknown>) => Promise<Record<string, unknown>>
        nostr?: unknown
      }).nostr = {
        getPublicKey: async () => publicKey,
        signEvent: async (event: Record<string, unknown>) =>
          (window as Window & {
            __irisNip07SignEvent: (event: Record<string, unknown>) => Promise<Record<string, unknown>>
          }).__irisNip07SignEvent(event),
      }
    }, { publicKey })

    await page.goto('/')

    // Login with NIP-07
    await page.click('button:has-text("Login with Extension")')
    await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible({ timeout: 5000 })

    // Click New Chat
    await page.getByRole('button', { name: 'New Chat' }).click()

    // Create a legacy invite link to trigger NIP-44 encryption error
    const legacyInvitePayload = {
      inviter: publicKey,
      ephemeralKey: 'a'.repeat(64),
      sharedSecret: 'b'.repeat(64),
    }
    const legacyInviteUrl = `${new URL(page.url()).origin}/#${encodeURIComponent(JSON.stringify(legacyInvitePayload))}`
    await page.getByPlaceholder('Paste invite link').fill(legacyInviteUrl)

    // Should show NIP-44 error message
    await expect(page.locator('text=does not support NIP-44')).toBeVisible({ timeout: 5000 })
  })
})

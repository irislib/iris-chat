import { test, expect } from '@playwright/test'
import { generateSecretKey, getPublicKey, nip44 } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'

// Helper to inject NIP-07 mock with real NIP-44 encryption
function createNip07InitScript(privateKeyHex: string, publicKey: string) {
  return `
    (function() {
      const privateKeyHex = "${privateKeyHex}";
      const publicKey = "${publicKey}";

      // Convert hex to bytes
      function hexToBytes(hex) {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        }
        return bytes;
      }

      const privateKey = hexToBytes(privateKeyHex);

      window.nostr = {
        getPublicKey: async () => publicKey,
        signEvent: async (event) => ({
          ...event,
          id: Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map(b => b.toString(16).padStart(2, '0')).join(''),
          pubkey: publicKey,
          sig: Array.from(crypto.getRandomValues(new Uint8Array(64)))
            .map(b => b.toString(16).padStart(2, '0')).join('')
        }),
        nip44: {
          // Simple mock for testing - real NIP-44 would need full implementation
          encrypt: async (pubkey, plaintext) => btoa(unescape(encodeURIComponent(plaintext))),
          decrypt: async (pubkey, ciphertext) => decodeURIComponent(escape(atob(ciphertext)))
        }
      };
    })();
  `;
}

test.describe('NIP-07 Login', () => {
  test('should login with NIP-07 extension', async ({ page }) => {
    const privateKey = generateSecretKey()
    const publicKey = getPublicKey(privateKey)

    // Inject mock NIP-07 before page loads
    await page.addInitScript((mockData) => {
      const { privateKeyHex, publicKey } = mockData

      // Convert hex back to Uint8Array
      const privateKey = new Uint8Array(privateKeyHex.match(/.{2}/g)!.map((b: string) => parseInt(b, 16)))

      // Simple NIP-44 implementation for testing
      ;(window as any).nostr = {
        getPublicKey: async () => publicKey,
        signEvent: async (event: any) => ({
          ...event,
          id: Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map(b => b.toString(16).padStart(2, '0')).join(''),
          pubkey: publicKey,
          sig: Array.from(crypto.getRandomValues(new Uint8Array(64)))
            .map(b => b.toString(16).padStart(2, '0')).join('')
        }),
        nip44: {
          encrypt: async (_pubkey: string, plaintext: string) => {
            // Simple mock encryption - just base64 encode for testing
            return btoa(plaintext)
          },
          decrypt: async (_pubkey: string, ciphertext: string) => {
            // Simple mock decryption - just base64 decode for testing
            return atob(ciphertext)
          }
        }
      }
    }, {
      privateKeyHex: Array.from(privateKey).map(b => b.toString(16).padStart(2, '0')).join(''),
      publicKey
    })

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
    const publicKey = getPublicKey(privateKey)

    // Inject mock NIP-07
    await page.addInitScript((mockData) => {
      const { publicKey } = mockData
      ;(window as any).nostr = {
        getPublicKey: async () => publicKey,
        signEvent: async (event: any) => ({
          ...event,
          id: Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map(b => b.toString(16).padStart(2, '0')).join(''),
          pubkey: publicKey,
          sig: Array.from(crypto.getRandomValues(new Uint8Array(64)))
            .map(b => b.toString(16).padStart(2, '0')).join('')
        }),
        nip44: {
          encrypt: async (_pubkey: string, plaintext: string) => btoa(plaintext),
          decrypt: async (_pubkey: string, ciphertext: string) => atob(ciphertext)
        }
      }
    }, { publicKey })

    await page.goto('/')

    // Login with NIP-07
    await page.click('button:has-text("Login with Extension")')
    await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible({ timeout: 5000 })

    // Click New Chat
    await page.getByRole('button', { name: 'New Chat' }).click()

    // Should see invite created (auto-created on first visit)
    await expect(page.locator('text=Invite #1')).toBeVisible({ timeout: 5000 })

    // Should have copy button for invite
    const copyButton = page.locator('button', { has: page.locator('span.i-carbon-copy') }).first()
    await expect(copyButton).toBeVisible()
  })

  test('should join chat via paste link with NIP-07 login', async ({ browser }) => {
    // User 1: Regular login (privkey) and create invite
    const context1 = await browser.newContext()
    const page1 = await context1.newPage()

    await page1.goto('/')
    await page1.getByRole('button', { name: 'Go' }).click()
    await page1.getByRole('button', { name: 'New Chat' }).click()

    // Get the invite URL
    const copyButton = page1.locator('button[title*="#"]').first()
    await expect(copyButton).toBeVisible()
    const inviteUrl = await copyButton.getAttribute('title')
    if (!inviteUrl) throw new Error('Could not get invite URL')

    // User 2: NIP-07 login and join via paste link
    const context2 = await browser.newContext()
    const page2 = await context2.newPage()

    const privateKey2 = generateSecretKey()
    const publicKey2 = getPublicKey(privateKey2)

    // Inject mock NIP-07 for user 2
    await page2.addInitScript((mockData) => {
      const { publicKey } = mockData
      ;(window as any).nostr = {
        getPublicKey: async () => publicKey,
        signEvent: async (event: any) => ({
          ...event,
          id: Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map(b => b.toString(16).padStart(2, '0')).join(''),
          pubkey: publicKey,
          sig: Array.from(crypto.getRandomValues(new Uint8Array(64)))
            .map(b => b.toString(16).padStart(2, '0')).join('')
        }),
        nip44: {
          encrypt: async (_pubkey: string, plaintext: string) => btoa(plaintext),
          decrypt: async (_pubkey: string, ciphertext: string) => atob(ciphertext)
        }
      }
    }, { publicKey: publicKey2 })

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

    // Inject mock NIP-07 WITHOUT nip44 support
    await page.addInitScript((mockData) => {
      const { publicKey } = mockData
      ;(window as any).nostr = {
        getPublicKey: async () => publicKey,
        signEvent: async (event: any) => ({
          ...event,
          id: Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map(b => b.toString(16).padStart(2, '0')).join(''),
          pubkey: publicKey,
          sig: Array.from(crypto.getRandomValues(new Uint8Array(64)))
            .map(b => b.toString(16).padStart(2, '0')).join('')
        })
        // NOTE: No nip44 property - simulating extension without NIP-44 support
      }
    }, { publicKey })

    await page.goto('/')

    // Login with NIP-07
    await page.click('button:has-text("Login with Extension")')
    await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible({ timeout: 5000 })

    // Click New Chat
    await page.getByRole('button', { name: 'New Chat' }).click()

    // Click Create Invite to trigger the error
    await page.getByRole('button', { name: 'Create Invite' }).click()

    // Should show NIP-44 error message
    await expect(page.locator('text=does not support NIP-44')).toBeVisible({ timeout: 5000 })
  })
})

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
})

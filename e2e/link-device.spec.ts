import { test, expect, useTestRelay } from './fixtures'
import type { BrowserContext, Page } from '@playwright/test'
import { generateSecretKey } from 'nostr-tools'

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function setIdentity(context: BrowserContext, privkeyHex: string) {
  await context.addInitScript((key: string) => {
    try {
      window.localStorage.setItem('iris-chat-identity', key)
    } catch {
      // Ignore opaque origins before the app document exists.
    }
  }, privkeyHex)
}

async function clearIdentity(context: BrowserContext) {
  await context.addInitScript(() => {
    try {
      window.localStorage.removeItem('iris-chat-identity')
    } catch {
      // Ignore opaque origins before the app document exists.
    }
  })
}

async function loginWithStoredKey(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible({ timeout: 30_000 })
}

async function openLinkThisDevice(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Link this device' }).click()
  await expect(page.getByRole('heading', { name: 'Link this device' })).toBeVisible({
    timeout: 10_000,
  })

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const buttons = page.locator('button[title]')
    const count = await buttons.count()
    for (let index = 0; index < count; index += 1) {
      const url = await buttons.nth(index).getAttribute('title')
      if (url?.match(/^[0-9a-f]{64}\.[0-9a-f]{64}$/)) return url
    }
    await page.waitForTimeout(100)
  }
  throw new Error('Could not read compact link-device approval code')
}

test('link another device closes on paste and logs the other browser in promptly', async ({
  browser,
  testRelayUrls,
}) => {
  const ownerContext = await browser.newContext()
  const linkedContext = await browser.newContext()

  await useTestRelay(ownerContext, testRelayUrls)
  await useTestRelay(linkedContext, testRelayUrls)
  await setIdentity(ownerContext, toHex(generateSecretKey()))
  await clearIdentity(linkedContext)

  const ownerPage = await ownerContext.newPage()
  const linkedPage = await linkedContext.newPage()

  try {
    await loginWithStoredKey(ownerPage)
    const approvalUrl = await openLinkThisDevice(linkedPage)
    expect(approvalUrl).toMatch(/^[0-9a-f]{64}\.[0-9a-f]{64}$/)
    expect(approvalUrl).not.toContain('https://chat.iris.to')
    expect(approvalUrl).not.toContain('relay=')
    expect(approvalUrl.length).toBe(129)
    const approvalParts = approvalUrl.split('.')
    expect(approvalParts).toHaveLength(2)
    expect(approvalParts[0]).toMatch(/^[0-9a-f]{64}$/)
    expect(approvalParts[1]).toMatch(/^[0-9a-f]{64}$/)

    await ownerPage.getByRole('button', { name: 'Settings' }).click()
    await ownerPage.getByRole('button', { name: 'Link another device' }).click()
    await expect(ownerPage.getByRole('heading', { name: 'Link another device' })).toBeVisible()

    await ownerPage.getByPlaceholder('Paste link code').fill(approvalUrl)

    await expect(ownerPage.getByRole('heading', { name: 'Link another device' })).toBeHidden({
      timeout: 750,
    })
    await expect(linkedPage.getByRole('button', { name: 'New Chat' })).toBeVisible({
      timeout: 3_000,
    })
  } finally {
    await ownerContext.close()
    await linkedContext.close()
  }
})

import { test, expect } from './fixtures'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'

for (const format of ['nsec', 'hex'] as const) {
  test(`existing account logs in with ${format} and survives reload`, async ({ page }, testInfo) => {
    let bootstrapRequests = 0
    await page.route('https://graph-api.iris.to/**', route => { bootstrapRequests++; return route.abort() })
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window)
      window.fetch = async (...args) => {
        const response = await originalFetch(...args)
        const input = args[0], url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (/socialGraph[^/]*\.bin/.test(url)) (window as Window & { graphSeedLoaded?: boolean }).graphSeedLoaded = true
        return response
      }
    })
    const secret = generateSecretKey()
    const hex = Buffer.from(secret).toString('hex')
    const input = format === 'nsec' ? nip19.nsecEncode(secret) : hex.toUpperCase()
    if (format === 'hex') await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Go', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Link this device', exact: true })).toBeHidden()
    await expect(page.getByRole('button', { name: 'Log in with secret key', exact: true })).toBeHidden()
    await page.screenshot({ path: testInfo.outputPath('welcome.png') })
    await page.getByRole('button', { name: 'Already have an account?' }).click()
    await expect(page.getByRole('heading', { name: 'Existing account' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Link this device', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('existing-account.png') })
    await page.getByRole('button', { name: 'Log in with secret key', exact: true }).click()
    const field = page.getByLabel('Secret key', { exact: true })
    await expect(field).toHaveAttribute('type', 'password')
    await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeDisabled()
    await page.screenshot({ path: testInfo.outputPath('secret-key.png') })
    await field.fill(`  ${input}  `)
    await field.press('Enter')
    await expect(page.getByRole('button', { name: 'New Chat', exact: true })).toBeVisible()
    // The fixture stores a custom local relay. A completed local seed fetch proves
    // the graph loader ran without adding the fixed public HTTP bootstrap.
    await expect.poll(() => page.evaluate(() => Boolean((window as Window & { graphSeedLoaded?: boolean }).graphSeedLoaded))).toBe(true)
    expect(bootstrapRequests).toBe(0)
    expect(await page.evaluate(() => localStorage.getItem('iris-chat-identity'))).toBe(hex)
    await page.reload()
    await expect(page.getByRole('button', { name: 'New Chat', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Profile', exact: true }).click()
    await expect(page.locator(`button[title="${nip19.npubEncode(getPublicKey(secret))}"]`)).toBeVisible()
  })
}

test('invalid keys stay signed out and backing out clears the secret', async ({ page }) => {
  await page.goto('/')
  await page.getByPlaceholder('Name', { exact: true }).fill('Alice')
  await page.getByRole('button', { name: 'Already have an account?' }).click()
  await page.getByRole('button', { name: 'Log in with secret key', exact: true }).click()
  const field = page.getByLabel('Secret key', { exact: true })
  for (const input of ['invalid', '0'.repeat(64), 'f'.repeat(64), nip19.npubEncode(getPublicKey(generateSecretKey()))]) {
    await field.fill(input)
    await page.getByRole('button', { name: 'Log in', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('Enter a valid secret key (nsec or hex).')
    expect(await page.evaluate(() => localStorage.getItem('iris-chat-identity'))).toBeNull()
  }
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByRole('button', { name: 'Log in with secret key', exact: true }).click()
  await expect(field).toHaveValue('')
  await expect(page.getByRole('alert')).toBeHidden()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.getByPlaceholder('Name', { exact: true })).toHaveValue('Alice')
  await page.getByRole('button', { name: 'Go', exact: true }).click()
  await expect(page.getByRole('button', { name: 'New Chat', exact: true })).toBeVisible()
})

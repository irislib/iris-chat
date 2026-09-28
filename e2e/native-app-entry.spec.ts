import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { nip19 } from 'nostr-tools'

const downloads = 'https://irischat.org/#downloads'
const preferenceKey = 'iris-native-app-suggestion'
const peer = nip19.npubEncode('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
const chatHash = `#/${peer}`

async function platform(page: Page, userAgent = 'iPhone Safari', maxTouchPoints = 5) {
  await page.addInitScript(({ userAgent, maxTouchPoints }) => {
    Object.defineProperty(navigator, 'userAgent', { value: userAgent })
    Object.defineProperty(navigator, 'maxTouchPoints', { value: maxTouchPoints })
  }, { userAgent, maxTouchPoints })
}

for (const [label, userAgent, touches] of [
  ['iPhone', 'iPhone Safari', 5],
  ['iPad', 'Macintosh Safari', 5],
  ['Android', 'Linux Android Chrome Mobile', 5],
  ['Mac', 'Macintosh Safari', 0],
  ['Windows', 'Windows NT 10.0 Chrome', 0],
  ['Linux', 'X11 Linux x86_64 Firefox', 0],
] as const) {
  test(`${label} entry offers the matching app without blocking web onboarding`, async ({ page }, info) => {
    await platform(page, userAgent, touches)
    await page.setViewportSize(touches ? { width: 390, height: 844 } : { width: 1280, height: 800 })
    await page.goto('/')
    const suggestion = page.getByRole('complementary', { name: 'Iris app' })
    await expect(suggestion.getByRole('link', { name: `Get Iris for ${label}` })).toHaveAttribute('href', downloads)
    await page.getByLabel('Your name (optional)').fill('Taylor')
    await expect(page.getByRole('button', { name: 'Go', exact: true })).toBeEnabled()
    const input = await page.getByLabel('Your name (optional)').boundingBox()
    const prompt = await suggestion.boundingBox()
    expect(prompt!.y).toBeGreaterThan(input!.y + input!.height)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (label === 'iPhone' || label === 'Mac') {
      await page.screenshot({ path: `work/native-app-entry/${info.project.name}-${label.toLowerCase()}-welcome.png` })
    }
    await suggestion.getByRole('button', { name: 'Dismiss app suggestion' }).click()
    await expect(suggestion).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('button', { name: 'Go', exact: true })).toBeVisible()
    await expect(suggestion).toHaveCount(0)
  })
}

test('first-entry suggestion stays seen after reload without requiring dismissal', async ({ page }) => {
  await platform(page)
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Get Iris for iPhone' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Go', exact: true })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Iris app' })).toHaveCount(0)
})

for (const standalone of [true, false]) {
  test(standalone ? 'standalone does not get a native suggestion' : 'unsupported platform does not get a native suggestion', async ({ page }) => {
    await platform(page, standalone ? 'iPhone Safari' : 'CrOS Chrome', 5)
    await page.addInitScript((standalone) => { Object.defineProperty(navigator, 'standalone', { value: standalone }) }, standalone)
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Go', exact: true })).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Iris app' })).toHaveCount(0)
  })
}

test('shared chat keeps native actions after dismissal and downloads preserve its destination privately', async ({ page, context }, info) => {
  await platform(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript((key) => localStorage.setItem(key, 'dismissed'), preferenceKey)
  let downloadReferrer: string | undefined
  await context.route('https://irischat.org/**', route => {
    downloadReferrer = route.request().headers().referer
    return route.fulfill({ contentType: 'text/html', body: '<h1>Downloads</h1>' })
  })
  await page.goto(`/${chatHash}`)
  await expect(page.getByRole('link', { name: 'Open in app', exact: true })).toHaveAttribute('href', `irischat://chat.iris.to/${chatHash}`)
  await expect(page.getByRole('button', { name: 'Join Chat', exact: true })).toBeEnabled()
  await page.screenshot({ path: `work/native-app-entry/${info.project.name}-iphone-chat-link.png` })
  const originalURL = page.url()
  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('link', { name: 'Get Iris for iPhone' }).click()
  const popup = await popupPromise
  await expect(popup).toHaveURL(downloads)
  expect(downloadReferrer).toBeUndefined()
  expect(page.url()).toBe(originalURL)
  await popup.close()
  await page.reload()
  await expect(page.getByRole('link', { name: 'Open in app', exact: true })).toHaveAttribute('href', `irischat://chat.iris.to/${chatHash}`)
})

test('encoded chat invite survives native handoff but device-link invites are excluded', async ({ page }) => {
  await platform(page)
  await page.addInitScript((key) => localStorage.setItem(key, 'dismissed'), preferenceKey)
  const payload = { inviter: 'b'.repeat(64), ephemeralKey: 'c'.repeat(64), sharedSecret: 'd'.repeat(64), purpose: 'chat' }
  const hash = `#/invite/${encodeURIComponent(JSON.stringify(payload))}`
  await page.goto(`/${hash}`)
  await expect(page.getByRole('link', { name: 'Open in app', exact: true })).toHaveAttribute('href', `irischat://chat.iris.to/${hash}`)
  await expect(page.getByRole('link', { name: 'Get Iris for iPhone' })).toHaveAttribute('href', downloads)
  await page.goto(`/#/invite/${encodeURIComponent(JSON.stringify({ ...payload, purpose: 'link' }))}`)
  await expect(page.getByRole('complementary', { name: 'Iris app' })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Go', exact: true })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Iris app' })).toHaveCount(0)
})

test('Windows chat entry offers download without an unregistered Open action', async ({ page }) => {
  await platform(page, 'Windows NT 10.0 Chrome', 0)
  await page.addInitScript((key) => localStorage.setItem(key, 'dismissed'), preferenceKey)
  await page.goto(`/${chatHash}`)
  await expect(page.getByRole('link', { name: 'Get Iris for Windows' })).toHaveAttribute('href', downloads)
  await expect(page.getByRole('link', { name: 'Open in app', exact: true })).toHaveCount(0)
})

test('standalone shared chat still offers the explicit native handoff', async ({ page }) => {
  await platform(page)
  await page.addInitScript((key) => {
    Object.defineProperty(navigator, 'standalone', { value: true })
    localStorage.setItem(key, 'dismissed')
  }, preferenceKey)
  await page.goto(`/${chatHash}`)
  await expect(page.getByRole('link', { name: 'Open in app', exact: true })).toHaveAttribute('href', `irischat://chat.iris.to/${chatHash}`)
  await expect(page.getByRole('link', { name: 'Get Iris for iPhone' })).toHaveAttribute('href', downloads)
})

test('web login retains the shared destination and settings keeps a download link', async ({ page }, info) => {
  await platform(page)
  await page.goto(`/${chatHash}`)
  await page.getByRole('button', { name: 'Join Chat', exact: true }).click()
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open in app', exact: true })).toHaveAttribute('href', `irischat://chat.iris.to/${chatHash}`)
  expect(new URL(page.url()).hash).toBe(chatHash)
  await page.reload()
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open in app', exact: true })).toHaveAttribute('href', `irischat://chat.iris.to/${chatHash}`)
  if (page.viewportSize()!.width < 768) {
    await page.screenshot({ path: `work/native-app-entry/${info.project.name}-iphone-shared-chat.png` })
    await page.getByRole('button', { name: 'Back', exact: true }).click()
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Iris app' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Get the native app', exact: true })).toHaveAttribute('href', downloads)
})

import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { nip19 } from 'nostr-tools'

test.use({ showNativeAppSuggestion: true })

const downloads = 'https://irischat.org/#downloads'
const preferenceKey = 'iris-native-app-suggestion'
const peer = nip19.npubEncode('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
const chatHash = `#/${peer}`
const suggestion = (page: Page) => page.getByRole('dialog', { name: 'Download Iris', exact: true })

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
  test(`${label} entry clearly offers a native download before web onboarding`, async ({ page }, info) => {
    await platform(page, userAgent, touches)
    const viewport = touches ? { width: 390, height: 844 } : { width: 1280, height: 800 }
    await page.setViewportSize(viewport)
    await page.goto('/')
    const dialog = suggestion(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('heading', { name: 'Download Iris', exact: true })).toBeVisible()
    expect(await dialog.evaluate(element => element.tagName === 'DIALOG' && element.matches(':modal'))).toBe(true)
    const download = dialog.getByRole('link', { name: `Download for ${label}`, exact: true })
    await expect(download).toHaveAttribute('href', downloads)
    await expect(download).toHaveAttribute('target', '_blank')
    await expect(download).toHaveAttribute('referrerpolicy', 'no-referrer')
    await expect(dialog.getByRole('link', { name: 'Open Iris', exact: true })).toHaveCount(0)
    const bounds = (await dialog.boundingBox())!
    if (touches) {
      expect(Math.abs(bounds.x)).toBeLessThan(1)
      expect(Math.abs(bounds.y)).toBeLessThan(1)
      expect(Math.abs(bounds.width - viewport.width)).toBeLessThan(1)
      expect(Math.abs(bounds.height - viewport.height)).toBeLessThan(1)
    } else {
      expect(bounds.width).toBeLessThan(viewport.width)
      expect(bounds.height).toBeLessThan(600)
      expect(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2)).toBeLessThan(2)
      expect(Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2)).toBeLessThan(2)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (label === 'iPhone' || label === 'Mac') {
      await page.screenshot({ path: `work/native-app-entry/${info.project.name}-${label.toLowerCase()}-welcome.png` })
    }
    await dialog.getByRole('button', { name: 'Continue in browser', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await page.getByLabel('Your name (optional)').fill('Taylor')
    await expect(page.getByRole('button', { name: 'Go', exact: true })).toBeEnabled()
  })
}

for (const dismissal of ['Continue in browser', 'Close download suggestion', 'Escape']) {
  test(`${dismissal} dismisses the download suggestion across welcome and shared links`, async ({ page }) => {
    await platform(page)
    await page.goto(`/${chatHash}`)
    await expect(suggestion(page)).toBeVisible()
    if (dismissal === 'Escape') await page.keyboard.press('Escape')
    else await suggestion(page).getByRole('button', { name: dismissal, exact: true }).click()
    await expect(suggestion(page)).toHaveCount(0)
    expect(await page.evaluate(key => localStorage.getItem(key), preferenceKey)).toBe('dismissed')
    expect(new URL(page.url()).hash).toBe(chatHash)
    await expect(page.getByRole('button', { name: 'Join Chat', exact: true })).toBeEnabled()
    await page.reload()
    await expect(page.getByRole('button', { name: 'Join Chat', exact: true })).toBeVisible()
    await expect(suggestion(page)).toHaveCount(0)
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Go', exact: true })).toBeVisible()
    await expect(suggestion(page)).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Download for iPhone', exact: true })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Open Iris', exact: true })).toHaveCount(0)
  })
}

test('an old seen marker does not count as choosing the browser', async ({ page }) => {
  await platform(page)
  await page.addInitScript(key => localStorage.setItem(key, 'seen'), preferenceKey)
  await page.goto('/')
  await expect(suggestion(page)).toBeVisible()
})

for (const standalone of [true, false]) {
  test(standalone ? 'standalone skips downloads even on shared chat links' : 'unsupported platforms skip downloads even on shared chat links', async ({ page }) => {
    await platform(page, standalone ? 'iPhone Safari' : 'CrOS Chrome', 5)
    await page.addInitScript(value => { Object.defineProperty(navigator, 'standalone', { value }) }, standalone)
    for (const entry of ['/', `/${chatHash}`]) {
      await page.goto(entry)
      // A hash-only goto reuses LoginView's original mount. Test a fresh link entry.
      if (entry !== '/') await page.reload()
      await expect(page.getByRole('button', { name: entry === '/' ? 'Go' : 'Join Chat', exact: true })).toBeVisible()
      await expect(suggestion(page)).toHaveCount(0)
    }
  })
}

test('shared chat downloads stay private and offer Open Iris only after downloading', async ({ page, context }, info) => {
  await platform(page)
  await page.setViewportSize({ width: 390, height: 844 })
  let downloadReferrer: string | undefined
  let downloadRequest: string | undefined
  await context.route('https://irischat.org/**', route => {
    downloadReferrer = route.request().headers().referer
    downloadRequest = route.request().url()
    return route.fulfill({ contentType: 'text/html', body: '<h1>Downloads</h1>' })
  })
  await page.goto(`/${chatHash}`)
  await expect(suggestion(page)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open Iris', exact: true })).toHaveCount(0)
  await page.screenshot({ path: `work/native-app-entry/${info.project.name}-iphone-chat-link.png` })
  const originalURL = page.url()
  const popupPromise = page.waitForEvent('popup')
  await suggestion(page).getByRole('link', { name: 'Download for iPhone', exact: true }).click()
  const popup = await popupPromise
  await expect(popup).toHaveURL(downloads)
  expect(downloadRequest).toBe('https://irischat.org/')
  expect(downloadReferrer).toBeUndefined()
  expect(page.url()).toBe(originalURL)
  expect(await page.evaluate(key => localStorage.getItem(key), preferenceKey)).toBe('opened')
  await popup.close()
  await expect(suggestion(page)).toBeVisible()
  await expect(suggestion(page).getByRole('link', { name: 'Open Iris', exact: true })).toHaveAttribute('href', `irischat://chat.iris.to/${chatHash}`)
  await page.reload()
  await expect(suggestion(page)).toBeVisible()
  await expect(suggestion(page).getByRole('link', { name: 'Open Iris', exact: true })).toHaveAttribute('href', `irischat://chat.iris.to/${chatHash}`)
  await page.screenshot({ path: `work/native-app-entry/${info.project.name}-iphone-after-download.png` })
})

test('a download already opened does not interrupt plain welcome', async ({ page }) => {
  await platform(page)
  await page.addInitScript(key => localStorage.setItem(key, 'opened'), preferenceKey)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Go', exact: true })).toBeVisible()
  await expect(suggestion(page)).toHaveCount(0)
})

test('encoded chat invites keep their exact handoff but device linking never prompts', async ({ page }) => {
  await platform(page)
  await page.addInitScript(key => localStorage.setItem(key, 'opened'), preferenceKey)
  const payload = { inviter: 'b'.repeat(64), ephemeralKey: 'c'.repeat(64), sharedSecret: 'd'.repeat(64), purpose: 'chat' }
  const hash = `#/invite/${encodeURIComponent(JSON.stringify(payload))}`
  await page.goto(`/${hash}`)
  await expect(suggestion(page).getByRole('link', { name: 'Open Iris', exact: true })).toHaveAttribute('href', `irischat://chat.iris.to/${hash}`)
  await expect(suggestion(page).getByRole('link', { name: 'Download for iPhone', exact: true })).toHaveAttribute('href', downloads)
  await page.goto(`/#/invite/${encodeURIComponent(JSON.stringify({ ...payload, purpose: 'link' }))}`)
  await expect(suggestion(page)).toHaveCount(0)
  expect(await page.evaluate(key => localStorage.getItem(key), preferenceKey)).toBe('opened')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Go', exact: true })).toBeVisible()
  await expect(suggestion(page)).toHaveCount(0)
})

test('Windows shared entry offers download without an unregistered Open Iris action', async ({ page }) => {
  await platform(page, 'Windows NT 10.0 Chrome', 0)
  await page.addInitScript(key => localStorage.setItem(key, 'opened'), preferenceKey)
  await page.goto(`/${chatHash}`)
  await expect(suggestion(page).getByRole('link', { name: 'Download for Windows', exact: true })).toHaveAttribute('href', downloads)
  await expect(page.getByRole('link', { name: 'Open Iris', exact: true })).toHaveCount(0)
})

test('choosing the browser preserves the shared chat without a download topbar after login', async ({ page }, info) => {
  await platform(page)
  await page.goto(`/${chatHash}`)
  await suggestion(page).getByRole('button', { name: 'Continue in browser', exact: true }).click()
  await page.getByRole('button', { name: 'Join Chat', exact: true }).click()
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible()
  expect(new URL(page.url()).hash).toBe(chatHash)
  await expect(suggestion(page)).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Download for iPhone', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Open Iris', exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible()
  expect(new URL(page.url()).hash).toBe(chatHash)
  await expect(suggestion(page)).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Download for iPhone', exact: true })).toHaveCount(0)
  await page.screenshot({ path: `work/native-app-entry/${info.project.name}-browser-shared-chat.png` })
  if (page.viewportSize()!.width < 768) await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Get the native app', exact: true })).toHaveAttribute('href', downloads)
})

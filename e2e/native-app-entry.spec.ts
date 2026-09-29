import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { nip19 } from 'nostr-tools'

test.use({ showNativeAppSuggestion: true })

const downloads = 'https://irischat.org/#downloads'
const appStore = 'https://apps.apple.com/app/iris-chat/id6785411684'
const releaseBase = 'https://cdn.iris.to/npub1399g0q2gtwjcglyjcg3jw3rcllqhm375pwases5hkvqa56aqe5wsz2eaap/releases%2Firis-chat-rs/latest'
const releaseManifest = `${releaseBase}/release.json`
const releaseAsset = (suffix: string) => `${releaseBase.replace(/latest$/, 'v2026.9.29')}/assets/iris-chat-v2026.9.29-${suffix}`
const manifest = {
  tag: 'v2026.9.29',
  assets: [
    ['macos-arm64.app.tar.gz', 'macos', 'arm64', 'app-bundle'],
    ['macos-arm64.dmg', 'macos', 'arm64', 'archive'],
    ['windows-x64.zip', 'windows', 'x64', 'archive'],
    ['windows-x64-setup.exe', 'windows', 'x64', 'nsis'],
    ['android-arm64.aab', 'android', 'arm64', 'archive'],
    ['android-arm64.apk', 'android', 'arm64', 'archive'],
    ['linux-x64.deb', 'linux', 'x64', 'deb'],
    ['linux-x64.tar.gz', 'linux', 'x64', 'archive'],
  ].map(([suffix, platform, architecture, kind]) => ({
    name: `iris-chat-v2026.9.29-${suffix}`,
    path: `assets/iris-chat-v2026.9.29-${suffix}`,
    platform, architecture, kind, size: 12345678, sha256: 'a'.repeat(64),
  })),
}

test.beforeEach(async ({ context }) => {
  await context.route(releaseManifest, route => route.fulfill({ json: manifest, headers: { 'Access-Control-Allow-Origin': '*' } }))
})
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

for (const [label, userAgent, touches, href] of [
  ['iPhone', 'iPhone Safari', 5, appStore],
  ['iPad', 'Macintosh Safari', 5, appStore],
  ['Android', 'Linux Android Chrome Mobile', 5, releaseAsset('android-arm64.apk')],
  ['Mac', 'Macintosh Safari', 0, releaseAsset('macos-arm64.dmg')],
  ['Windows', 'Windows NT 10.0 Chrome', 0, releaseAsset('windows-x64-setup.exe')],
  ['Linux', 'X11 Linux x86_64 Firefox', 0, releaseAsset('linux-x64.tar.gz')],
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
    await expect(download).toHaveAttribute('href', href)
    await expect(download).toHaveAttribute('target', '_blank')
    await expect(download).toHaveAttribute('referrerpolicy', 'no-referrer')
    const otherDownloads = dialog.getByRole('link', { name: 'Other downloads', exact: true })
    await expect(otherDownloads).toHaveAttribute('href', downloads)
    await expect(otherDownloads).toHaveAttribute('referrerpolicy', 'no-referrer')
    if (label === 'Mac') await expect(dialog.getByText('Apple silicon', { exact: true })).toBeVisible()
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

test('shared chat downloads stay private and offer Open Iris only after downloading', async ({ page, context, browserName }, info) => {
  await platform(page)
  await page.setViewportSize({ width: 390, height: 844 })
  let downloadReferrer: string | undefined
  let downloadRequest: string | undefined
  await context.route(appStore, route => {
    downloadReferrer = route.request().headers().referer
    downloadRequest = route.request().url()
    return route.fulfill({ contentType: 'text/html', body: '<h1>Iris Chat on the App Store</h1>' })
  })
  await page.goto(`/${chatHash}`)
  await expect(suggestion(page)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open Iris', exact: true })).toHaveCount(0)
  await page.screenshot({ path: `work/native-app-entry/${info.project.name}-iphone-chat-link.png` })
  const originalURL = page.url()
  const download = suggestion(page).getByRole('link', { name: 'Download for iPhone', exact: true })
  await expect(download).toHaveAttribute('href', appStore)
  await expect(download).toHaveAttribute('target', '_blank')
  await expect(download).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(download).toHaveAttribute('referrerpolicy', 'no-referrer')
  // WebKit exposes no HTTP request or popup for App Store links in this harness.
  // Chromium exercises the actual HTTP request; both exercise the click state.
  const popupPromise = browserName === 'webkit' ? null : page.waitForEvent('popup')
  await download.click()
  if (popupPromise) {
    const popup = await popupPromise
    await expect(popup).toHaveURL(appStore)
    expect(downloadRequest).toBe(appStore)
    expect(downloadReferrer).toBeUndefined()
    await popup.close()
  }
  expect(page.url()).toBe(originalURL)
  expect(await page.evaluate(key => localStorage.getItem(key), preferenceKey)).toBe('opened')
  await expect(suggestion(page)).toBeVisible()
  await expect(suggestion(page).getByRole('link', { name: 'Open Iris', exact: true })).toHaveAttribute('href', `irischat://chat.iris.to/${chatHash}`)
  await page.reload()
  await expect(suggestion(page)).toBeVisible()
  await expect(suggestion(page).getByRole('link', { name: 'Open Iris', exact: true })).toHaveAttribute('href', `irischat://chat.iris.to/${chatHash}`)
  await page.screenshot({ path: `work/native-app-entry/${info.project.name}-iphone-after-download.png` })
})

test('Mac shared invite downloads a disk image without exposing the invite', async ({ page, context, browserName }) => {
  await platform(page, 'Macintosh Safari', 0)
  const payload = { inviter: 'b'.repeat(64), ephemeralKey: 'c'.repeat(64), sharedSecret: 'd'.repeat(64), purpose: 'chat' }
  const hash = `#/invite/${encodeURIComponent(JSON.stringify(payload))}`
  const assetURL = releaseAsset('macos-arm64.dmg')
  const filename = 'iris-chat-v2026.9.29-macos-arm64.dmg'
  const requests: { url: string; referer?: string }[] = []
  await context.route(releaseManifest, route => {
    requests.push({ url: route.request().url(), referer: route.request().headers().referer })
    return route.fulfill({ json: manifest, headers: { 'Access-Control-Allow-Origin': '*' } })
  })
  await context.route(assetURL, route => {
    requests.push({ url: route.request().url(), referer: route.request().headers().referer })
    return route.fulfill({
      contentType: 'application/octet-stream',
      headers: { 'Content-Disposition': `attachment; filename="${filename}"` },
      body: 'mock Iris disk image',
    })
  })
  await page.goto(`/${hash}`)
  const downloadLink = suggestion(page).getByRole('link', { name: 'Download for Mac', exact: true })
  await expect(downloadLink).toHaveAttribute('href', assetURL)
  // WebKit exposes this attachment response on a blank popup, but its test
  // harness emits no download event. Chromium also verifies saved file bytes.
  const responsePromise = browserName === 'webkit'
    ? context.waitForEvent('response', response => response.url() === assetURL) : null
  const downloadPromise = browserName === 'webkit' ? null : page.waitForEvent('download')
  await downloadLink.click()
  if (responsePromise) {
    const response = await responsePromise
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toBe('application/octet-stream')
    expect(response.headers()['content-disposition']).toBe(`attachment; filename="${filename}"`)
  }
  if (downloadPromise) {
    const download = await downloadPromise
    expect(download.url()).toBe(assetURL)
    expect(download.suggestedFilename()).toBe(filename)
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks).toString()).toBe('mock Iris disk image')
  }
  expect(requests).toEqual([
    { url: releaseManifest, referer: undefined },
    { url: assetURL, referer: undefined },
  ])
  expect(new URL(page.url()).hash).toBe(hash)
  await expect(suggestion(page)).toBeVisible()
  await expect(suggestion(page).getByRole('link', { name: 'Open Iris', exact: true })).toHaveAttribute('href', `irischat://chat.iris.to/${hash}`)
})

for (const failure of ['unavailable', 'missing-platform'] as const) {
  test(`an ${failure} manifest keeps a usable downloads fallback`, async ({ page, context }) => {
    await platform(page, 'Macintosh Safari', 0)
    await context.route(releaseManifest, route => failure === 'unavailable'
      ? route.fulfill({ status: 503, body: 'Temporarily unavailable', headers: { 'Access-Control-Allow-Origin': '*' } })
      : route.fulfill({ json: { ...manifest, assets: manifest.assets.filter(asset => asset.platform !== 'macos') }, headers: { 'Access-Control-Allow-Origin': '*' } }))
    const manifestResponse = page.waitForResponse(releaseManifest)
    await page.goto(`/${chatHash}`)
    await (await manifestResponse).finished()
    const dialog = suggestion(page)
    await expect(dialog.getByRole('link', { name: 'Download for Mac', exact: true })).toHaveAttribute('href', downloads)
    await expect(dialog.getByRole('link', { name: 'Other downloads', exact: true })).toHaveAttribute('href', downloads)
    await dialog.getByRole('button', { name: 'Continue in browser', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect(new URL(page.url()).hash).toBe(chatHash)
    await expect(page.getByRole('button', { name: 'Join Chat', exact: true })).toBeEnabled()
  })
}

for (const [label, viewport] of [
  ['small-phone', { width: 320, height: 568 }],
  ['short-landscape', { width: 568, height: 320 }],
] as const) {
  test(`${label} keeps download and browser controls reachable before and after download`, async ({ page, context, browserName }, info) => {
    await platform(page)
    await page.setViewportSize(viewport)
    await context.route(appStore, route => route.fulfill({ contentType: 'text/html', body: '<h1>Iris Chat on the App Store</h1>' }))
    await page.goto(`/${chatHash}`)
    const dialog = suggestion(page)
    const primary = dialog.getByRole('link', { name: 'Download for iPhone', exact: true })
    const browser = dialog.getByRole('button', { name: 'Continue in browser', exact: true })
    const close = dialog.getByRole('button', { name: 'Close download suggestion', exact: true })
    const other = dialog.getByRole('link', { name: 'Other downloads', exact: true })
    await expect(primary).toHaveAttribute('href', appStore)
    for (const afterDownload of [false, true]) {
      await expect(dialog).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      for (const control of [primary, browser, close, other]) {
        await control.scrollIntoViewIfNeeded()
        await expect(control).toBeInViewport({ ratio: 1 })
        await control.click({ trial: true })
      }
      if (afterDownload) {
        const open = dialog.getByRole('link', { name: 'Open Iris', exact: true })
        await open.scrollIntoViewIfNeeded()
        await expect(open).toBeInViewport({ ratio: 1 })
        await open.click({ trial: true })
      }
      await dialog.evaluate(element => { element.scrollTop = 0 })
      await page.screenshot({ path: `work/native-app-entry/${info.project.name}-${label}-${afterDownload ? 'after-download' : 'welcome'}.png` })
      if (!afterDownload) {
        // WebKit exposes no App Store popup in this harness, as covered above.
        const popupPromise = browserName === 'webkit' ? null : page.waitForEvent('popup')
        await primary.click()
        if (popupPromise) {
          const popup = await popupPromise
          await expect(popup).toHaveURL(appStore)
          await popup.close()
        }
      }
    }
    await browser.click()
    await expect(dialog).toHaveCount(0)
    expect(new URL(page.url()).hash).toBe(chatHash)
  })
}

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
  await expect(suggestion(page).getByRole('link', { name: 'Download for iPhone', exact: true })).toHaveAttribute('href', appStore)
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
  await expect(suggestion(page).getByRole('link', { name: 'Download for Windows', exact: true })).toHaveAttribute('href', releaseAsset('windows-x64-setup.exe'))
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

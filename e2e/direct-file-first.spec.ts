import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { webkit, devices } from '@playwright/test'
import { test, expect, useTestRelay } from './fixtures'
import { useDirectFileDestination } from './fixtures/directFileDestination'
import { startLocalFipsWebSocketSeed } from './fixtures/localFipsWebSocketSeed'

for (const mode of ['chosen destination', 'downloads after restart']) test(`first files use ${mode}`,  async ({ browser, testRelayUrl, baseURL }, info) => {
  test.skip(mode === 'chosen destination' && info.project.name !== 'chromium', 'Native file pickers are Chromium-only; other browsers use Downloads')
  test.setTimeout(120_000)
  const seed = await startLocalFipsWebSocketSeed()
  const profiles: string[] = []
  const newContext = () => {
    if (info.project.name !== 'webkit-files') return browser.newContext()
    // WebKit's ephemeral testing sessions disable OPFS; regular Safari profiles support it.
    const profile = mkdtempSync(path.join(tmpdir(), 'iris-file-webkit-'))
    profiles.push(profile)
    return webkit.launchPersistentContext(profile, { ...devices['iPhone 13'], baseURL, acceptDownloads: true })
  }
  const contexts = await Promise.all([newContext(), newContext()])
  const logs: string[] = []
  const bytes = Buffer.alloc(mode === 'downloads after restart' ? 4 * 1024 * 1024 : 512 * 1024, 123)
  try {
    for (const context of contexts) {
      await useTestRelay(context, testRelayUrl)
      if (mode === 'chosen destination') await useDirectFileDestination(context)
      else await context.addInitScript(() => Object.assign(window, { showSaveFilePicker: undefined, showDirectoryPicker: undefined, __filePickerCalls: [] }))
      await context.addInitScript(seedUrl => {
        localStorage.setItem('iris-chat-call-servers', JSON.stringify({ servers: [seedUrl], stunServers: [] }))
        window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
          construct() { throw new Error('Use the isolated routed file connection') },
        })
      }, seed.url)
    }
    const [a, b] = await Promise.all(contexts.map(context => context.newPage()))
    for (const [label, page] of [['A', a], ['B', b]] as const) {
      page.on('console', event => logs.push(`${label} ${event.type()} ${event.text()}`))
      page.on('pageerror', error => logs.push(`${label} ${error.message}`))
    }
    await a.goto('/')
    await a.getByRole('button', { name: 'Go', exact: true }).click()
    await a.getByRole('button', { name: 'New Chat', exact: true }).click()
    await expect(a.getByLabel('Open chat when someone joins')).toBeChecked()
    await a.getByTitle('Show QR Code').first().click()
    const copy = a.locator('button[title*="#/nhash"]').first()
    const invite = (await copy.getAttribute('title'))!.replace('https://chat.iris.to', new URL(a.url()).origin)
    await b.goto(invite)
    await b.getByRole('button', { name: 'Join Chat', exact: true }).click()
    // Registration rechecks the latest signed device list before accepting.
    await expect(b.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 5000 })
    await expect(a.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 2000 })
    await expect(a.getByRole('dialog')).toHaveCount(0)
    await a.getByRole('button', { name: 'Attach file', exact: true }).click()
    const selection = a.waitForEvent('filechooser')
    await a.getByRole('button', { name: 'Send directly', exact: true }).click()
    await (await selection).setFiles({ name: 'first-file.bin', mimeType: 'application/octet-stream', buffer: bytes })
    await a.getByRole('button', { name: 'Send', exact: true }).click()
    const card = b.locator('[data-testid^="direct-file-transfer-"]').first()
    await expect(card.getByRole('button', { name: 'Accept', exact: true })).toBeVisible({ timeout: 10_000 })
    expect(await b.evaluate(() => (window as unknown as { __filePickerCalls: string[] }).__filePickerCalls)).toEqual([])
    if (mode === 'downloads after restart') seed.shape(800_000)
    await card.getByRole('button', { name: 'Accept', exact: true }).click()
    if (mode === 'downloads after restart') {
      await expect.poll(() => card.getByRole('progressbar').getAttribute('value').then(Number), { timeout: 40_000 }).toBeGreaterThan(1024 * 1024)
      seed.shape(0)
      await Promise.all([a.reload(), b.reload()])
      await expect(card.getByRole('button', { name: 'Resume', exact: true })).toBeVisible()
      await expect.poll(() => card.getByRole('progressbar').getAttribute('value').then(Number)).toBeGreaterThanOrEqual(1024 * 1024)
      await b.screenshot({ path: info.outputPath('paused.png') })
      seed.shape(Infinity)
      await card.getByRole('button', { name: 'Resume', exact: true }).click()
    }
    await expect(card.getByRole('status')).toHaveText('Received', { timeout: 45_000 })
    expect(await b.evaluate(() => (window as unknown as { __filePickerCalls: string[] }).__filePickerCalls)).toEqual(mode === 'chosen destination' ? ['first-file.bin'] : [])
    const download = b.waitForEvent('download')
    await card.getByRole('button', { name: 'Download first-file.bin', exact: true }).click()
    const { readFileSync } = await import('node:fs')
    expect(readFileSync((await (await download).path())!).equals(bytes)).toBe(true)
    await expect(a.locator('[data-testid^="direct-file-transfer-"]').getByRole('status')).toHaveText('Sent')
    await b.screenshot({ path: info.outputPath('received.png') })
  } finally {
    await info.attach('browser-log', { body: logs.join('\n'), contentType: 'text/plain' })
    await Promise.all(contexts.map(context => context.close()))
    await seed.close()
    for (const profile of profiles) rmSync(profile, { recursive: true, force: true })
  }
})

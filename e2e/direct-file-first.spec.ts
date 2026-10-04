import { test, expect, useTestRelay } from './fixtures'
import { useDirectFileDestination } from './fixtures/directFileDestination'
import { startLocalFipsWebSocketSeed } from './fixtures/localFipsWebSocketSeed'

test('an invite can send files as its first content and streams to the chosen save location', async ({ browser, testRelayUrl }, info) => {
  test.setTimeout(90_000)
  const seed = await startLocalFipsWebSocketSeed()
  const contexts = await Promise.all([browser.newContext(), browser.newContext()])
  const logs: string[] = []
  const bytes = Buffer.alloc(512 * 1024, 123)
  try {
    for (const context of contexts) {
      await useTestRelay(context, testRelayUrl)
      await useDirectFileDestination(context)
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
    const copy = a.locator('button[title*="#/invite/"]').first()
    const invite = (await copy.getAttribute('title'))!.replace('https://chat.iris.to', new URL(a.url()).origin)
    await b.goto(invite)
    await b.getByRole('button', { name: 'Join Chat', exact: true }).click()
    await expect(b.getByPlaceholder('Type a message...')).toBeVisible({ timeout: 2000 })
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
    await card.getByRole('button', { name: 'Accept', exact: true }).click()
    await expect(card.getByRole('status')).toHaveText('Received', { timeout: 45_000 })
    expect(await b.evaluate(() => (window as unknown as { __filePickerCalls: string[] }).__filePickerCalls)).toEqual(['first-file.bin'])
    const received = await b.evaluate(async () => {
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('chosen-downloads')
      const file = await (await directory.getFileHandle('first-file.bin')).getFile()
      return { bytes: file.size, hash: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))) }
    })
    const { createHash } = await import('node:crypto')
    expect(received).toEqual({ bytes: bytes.length, hash: [...createHash('sha256').update(bytes).digest()] })
    await expect(a.locator('[data-testid^="direct-file-transfer-"]').getByRole('status')).toHaveText('Sent')
    await b.screenshot({ path: 'work/web-join/file-first-received.png' })
  } finally {
    await info.attach('browser-log', { body: logs.join('\n'), contentType: 'text/plain' })
    await Promise.all(contexts.map(context => context.close()))
    await seed.close()
  }
})

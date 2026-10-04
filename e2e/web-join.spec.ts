import { test, expect, useTestRelay } from './fixtures'
import type { Page } from '@playwright/test'
import { nip19 } from 'nostr-tools'

const composer = (page: Page) => page.getByPlaceholder('Type a message...')
const bubble = (page: Page, text: string) => page.locator('.max-w-\\[85\\%\\]').filter({ hasText: text })

async function send(page: Page, text: string) {
  await composer(page).fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

for (const dismissal of ['Continue in browser', 'Close download suggestion', 'Escape']) {
  test(`desktop name is focused after ${dismissal}`, async ({ browser, testRelayUrl }, info) => {
    const context = await browser.newContext()
    await useTestRelay(context, testRelayUrl, { showNativeAppSuggestion: true })
    const page = await context.newPage()
    try {
      await page.goto('/')
      const dialog = page.getByRole('dialog', { name: 'Download Iris', exact: true })
      await expect(dialog).toBeVisible()
      if (dismissal === 'Escape') await page.keyboard.press('Escape')
      else await dialog.getByRole('button', { name: dismissal, exact: true }).click()
      await expect(page.getByLabel('Your name (optional)')).toBeFocused({ timeout: 1000 })
      await page.keyboard.type('Taylor')
      await expect(page.getByLabel('Your name (optional)')).toHaveValue('Taylor')
      await page.screenshot({ path: `work/web-join/${info.testId}-focus.png` })
    } finally { await context.close() }
  })
}

test('a hash-only join opens immediately while another chat is selected', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Go', exact: true }).click()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await page.getByPlaceholder('Paste invite link').fill(nip19.npubEncode('b'.repeat(64)))
  await expect(composer(page)).toBeVisible()
  await page.goto(`/#/${nip19.npubEncode('c'.repeat(64))}`)
  await expect(page).toHaveURL(new URL('/', page.url()).href, { timeout: 1000 })
  await expect(composer(page)).toBeVisible({ timeout: 1000 })
})

test('unchecking Open chat when someone joins keeps the invite QR open when someone joins and messages', async ({ browser, testRelayUrl }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()])
  try {
    await Promise.all(contexts.map(context => useTestRelay(context, testRelayUrl)))
    const [a, b] = await Promise.all(contexts.map(context => context.newPage()))
    await a.goto('/')
    await a.getByRole('button', { name: 'Go', exact: true }).click()
    await a.getByRole('button', { name: 'New Chat', exact: true }).click()
    await a.getByTitle('Show QR Code').first().click()
    await a.getByLabel('Open chat when someone joins').uncheck()
    await a.screenshot({ path: 'work/web-join/qr-close-on-accept.png' })
    const invite = (await a.locator('button[title*="#/invite/"]').first().getAttribute('title'))!
      .replace('https://chat.iris.to', new URL(a.url()).origin)
    await b.goto(invite)
    await b.getByRole('button', { name: 'Join Chat', exact: true }).click()
    await expect(composer(b)).toBeVisible({ timeout: 2000 })
    await send(b, 'Keep this QR open')
    await expect(a.getByTestId('sidebar-chat-list').getByText('Keep this QR open', { exact: true })).toBeVisible()
    await expect(a.getByRole('dialog')).toBeVisible()
    await expect(a.getByLabel('Open chat when someone joins')).not.toBeChecked()
    await expect(composer(a)).toHaveCount(0)
  } finally { await Promise.all(contexts.map(context => context.close())) }
})

for (const entry of ['url', 'paste'] as const) {
  test(`fresh browsers exchange live replies after ${entry} join without device setup`, async ({ browser, testRelayUrl }, info) => {
    test.setTimeout(120_000)
    const contexts = await Promise.all([browser.newContext(), browser.newContext()])
    const logs: string[] = []
    try {
      await Promise.all(contexts.map(context => useTestRelay(context, testRelayUrl)))
      const [alice, bob] = await Promise.all(contexts.map(context => context.newPage()))
      for (const [label, page] of [['A', alice], ['B', bob]] as const) {
        page.on('console', message => logs.push(`${Date.now()} ${label} ${message.type()} ${message.text()}`))
        page.on('pageerror', error => logs.push(`${label} pageerror ${error.message}`))
      }
      await alice.goto('/')
      await alice.getByRole('button', { name: 'Go', exact: true }).click()
      await alice.getByRole('button', { name: 'New Chat', exact: true }).click()
      const copy = alice.locator('button[title*="#/invite/"]').first()
      await expect(copy).toBeVisible()
      const invite = (await copy.getAttribute('title'))!.replace('https://chat.iris.to', new URL(alice.url()).origin)
      if (entry === 'url') {
        await bob.goto(invite)
        await bob.getByRole('button', { name: 'Join Chat', exact: true }).click()
        await expect.soft(bob).toHaveURL(new URL('/', bob.url()).href, { timeout: 1000 })
        await expect.soft(bob.getByRole('status').filter({ hasText: 'Joining chat' }).or(composer(bob))).toBeVisible({ timeout: 1000 })
      } else {
        await bob.goto('/')
        await bob.getByRole('button', { name: 'Go', exact: true }).click()
        await bob.getByRole('button', { name: 'New Chat', exact: true }).click()
        await bob.getByPlaceholder('Paste invite link').fill(invite)
        await expect.soft(bob.getByRole('status').filter({ hasText: 'Joining chat' }).or(composer(bob))).toBeVisible({ timeout: 1000 })
      }
      await expect(composer(bob)).toBeVisible()
      await expect(composer(alice)).toBeVisible({ timeout: 2000 })
      await send(bob, 'First hello from B')
      await expect(bubble(alice, 'First hello from B')).toBeVisible({ timeout: 10_000 })
      await send(alice, 'Immediate reply from A')
      await expect(bubble(bob, 'Immediate reply from A')).toBeVisible({ timeout: 10_000 })
      await send(bob, 'Second message from B')
      await expect(bubble(alice, 'Second message from B')).toBeVisible({ timeout: 10_000 })
      await send(alice, 'Second reply from A')
      await expect(bubble(bob, 'Second reply from A')).toBeVisible({ timeout: 10_000 })
      await bob.screenshot({ path: `work/web-join/${entry}-roundtrip.png` })
    } finally {
      await info.attach('browser-log', { body: logs.join('\n'), contentType: 'text/plain' })
      await Promise.all(contexts.map(context => context.close()))
    }
  })
}

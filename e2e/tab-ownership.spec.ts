import { test, expect, useTestRelay } from './fixtures'
import type { Page } from '@playwright/test'

const blockedTitle = 'Already open in another tab'

const send = async (page: Page, text: string) => {
  await page.getByPlaceholder('Type a message...').fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

test('duplicating a signed-in tab keeps one writer and permits reload and handoff', async ({ page, context, browser, testRelayUrl }, info) => {
  const peerContext = await browser.newContext()
  await useTestRelay(peerContext, testRelayUrl)
  const peer = await peerContext.newPage()
  try {
    await page.goto('/')
    await page.getByRole('button', { name: 'Go', exact: true }).click()
    await expect(page.getByRole('button', { name: 'New Chat', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    const copy = page.locator('button[title*="#/nhash"]').first()
    await expect(copy).toBeVisible()
    const invite = (await copy.getAttribute('title'))!.replace('https://chat.iris.to', new URL(page.url()).origin)
    await peer.goto(invite)
    await peer.getByRole('button', { name: 'Join Chat', exact: true }).click()
    await send(peer, 'Before duplicate')
    await page.getByTestId('sidebar-chat-list').getByText('Before duplicate', { exact: true }).click()
    const received = (tab: Page, text: string) => tab.getByTestId('message-bubble-body').getByText(text, { exact: true })
    await expect(received(page, 'Before duplicate')).toBeVisible()

    // An opener copies sessionStorage, as ordinary browser tab duplication does.
    await page.evaluate(() => sessionStorage.setItem('duplication-proof', 'inherited'))
    const popup = page.waitForEvent('popup')
    await page.evaluate(() => { window.open(location.href, '_blank') })
    const duplicate = await popup
    await duplicate.waitForLoadState('domcontentloaded')
    expect(await duplicate.evaluate(() => sessionStorage.getItem('duplication-proof'))).toBe('inherited')
    await expect(duplicate.getByRole('heading', { name: blockedTitle })).toBeVisible({ timeout: 5_000 })
    await expect(duplicate.getByRole('button', { name: 'New Chat', exact: true })).toBeHidden()
    await duplicate.screenshot({ path: info.outputPath('duplicate-blocked.png') })

    await page.reload()
    await expect(page.getByRole('button', { name: 'New Chat', exact: true })).toBeVisible()
    await expect(duplicate.getByRole('heading', { name: blockedTitle })).toBeVisible()
    await expect(received(page, 'Before duplicate')).toBeVisible()
    await send(page, 'After owner reload')
    await expect(received(peer, 'After owner reload')).toBeVisible()
    await page.close()
    await duplicate.reload()
    await expect(duplicate.getByRole('button', { name: 'New Chat', exact: true })).toBeVisible()
    await expect(received(duplicate, 'Before duplicate')).toBeVisible()
    await send(duplicate, 'After handoff')
    await expect(received(peer, 'After handoff')).toBeVisible()
    await send(peer, 'Handoff reply')
    await expect(received(duplicate, 'Handoff reply')).toBeVisible()
    await duplicate.screenshot({ path: info.outputPath('handoff-messaging.png') })
    await duplicate.close()
    const reopened = await context.newPage()
    await reopened.goto('/')
    await expect(reopened.getByRole('button', { name: 'New Chat', exact: true })).toBeVisible()
    await reopened.getByTestId('sidebar-chat-list').getByText('Handoff reply', { exact: true }).click()
    await expect(received(reopened, 'Handoff reply')).toBeVisible()
  } finally { await peerContext.close() }
})

test('a delayed tab reply cannot admit a second writer', async ({ page, context }) => {
  await context.addInitScript(() => {
    const post = BroadcastChannel.prototype.postMessage
    BroadcastChannel.prototype.postMessage = function (message: unknown) {
      if (this.name === 'iris-chat-tab') setTimeout(() => post.call(this, message), 1_000)
      else post.call(this, message)
    }
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Go', exact: true })).toBeVisible()
  const other = await context.newPage()
  await other.goto('/')
  // Inspect the first settled screen, rather than relying on a short timeout.
  await expect(other.getByRole('heading', { name: blockedTitle }).or(other.getByRole('button', { name: 'Go', exact: true }))).toBeVisible()
  expect(await other.getByRole('heading', { name: blockedTitle }).isVisible()).toBe(true)
  await expect(page.getByRole('button', { name: 'Go', exact: true })).toBeVisible()
})

test('a suspended signed-in owner keeps exclusive ownership', async ({ page, context }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Go', exact: true }).click()
  await expect(page.getByRole('button', { name: 'New Chat', exact: true })).toBeVisible()
  const session = await context.newCDPSession(page)
  await session.send('Page.setWebLifecycleState', { state: 'frozen' })
  try {
    const other = await context.newPage()
    await other.goto('/')
    await expect(other.getByRole('heading', { name: blockedTitle }).or(other.getByRole('button', { name: 'New Chat', exact: true }))).toBeVisible()
    expect(await other.getByRole('heading', { name: blockedTitle }).isVisible()).toBe(true)
  } finally {
    await session.send('Page.setWebLifecycleState', { state: 'active' })
    await session.detach()
  }
  await expect(page.getByRole('button', { name: 'New Chat', exact: true })).toBeVisible()
})

test('unavailable ownership fails closed before login', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Could not safely open chat' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Go', exact: true })).toBeHidden()
})

test('a legacy owner can upgrade while a blocked tab stays open', async ({ page, context }) => {
  // The exact pre-lock ping/pong protocol, with no private-runtime fixture.
  await page.route('**/legacy-owner', route => route.fulfill({
    contentType: 'text/html',
    body: `<script>
      const channel = new BroadcastChannel('iris-chat-tab');
      channel.onmessage = event => {
        if (event.data?.type === 'ping') channel.postMessage({type: 'pong', tabId: 'legacy-owner'});
      };
    </script><h1>Legacy owner ready</h1>`,
  }))
  await page.goto('/legacy-owner')
  await expect(page.getByRole('heading', { name: 'Legacy owner ready' })).toBeVisible()
  const other = await context.newPage()
  await other.goto('/')
  await expect(other.getByRole('heading', { name: blockedTitle })).toBeVisible()
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Go', exact: true })).toBeVisible()
  await expect(other.getByRole('heading', { name: blockedTitle })).toBeVisible()
})

test('navigation back cannot resume a writer after another tab takes ownership', async ({ page, context }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Go', exact: true })).toBeVisible()
  await page.goto('about:blank')
  const other = await context.newPage()
  await other.goto('/')
  await expect(other.getByRole('button', { name: 'Go', exact: true })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: blockedTitle })).toBeVisible()
  await expect(other.getByRole('button', { name: 'Go', exact: true })).toBeVisible()
})

test('parallel opens admit exactly one foreground tab', async ({ page, context }) => {
  const other = await context.newPage()
  // Release both real entry bundles together, without changing app coordination.
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  let arrivals = 0
  await context.route(/\/assets\/index-[^/]+\.js$/, async route => {
    if (++arrivals === 2) release()
    await ready
    await route.continue()
  })
  await Promise.all([page.goto('/'), other.goto('/')])
  const tabs = [page, other]
  await expect.poll(async () => Promise.all(tabs.map(async tab => {
    if (await tab.getByRole('button', { name: 'Go', exact: true }).isVisible()) return 'active'
    if (await tab.getByRole('heading', { name: blockedTitle }).isVisible()) return 'blocked'
    return 'loading'
  })), { timeout: 10_000 }).toEqual(expect.arrayContaining(['active', 'blocked']))
})

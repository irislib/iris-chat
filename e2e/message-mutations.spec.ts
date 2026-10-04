import { test, expect, useTestRelay } from './fixtures'
import { nip19 } from 'nostr-tools'
import type { Page } from '@playwright/test'

async function openPeer(page: Page, pubkey: string) {
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await page.getByPlaceholder('Paste invite link').fill(nip19.npubEncode(pubkey))
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible()
}
async function start(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Go', exact: true }).click()
}
async function reopen(page: Page, content: string) {
  if (await bubble(page, content).isVisible()) return
  await expect(async () => {
    for (const tab of [page.getByTestId('sidebar-tab-all'), page.getByTestId('sidebar-tab-requests')]) {
      await tab.click()
      const item = page.getByTestId('sidebar-chat-list').getByRole('button').filter({ hasText: content }).first()
      if (await item.isVisible()) { await item.click(); return }
    }
    throw new Error('Waiting for conversation')
  }).toPass({ timeout: 10000 })
}
const bubble = (page: Page, content: string) => page.locator('[id^="msg-"]').filter({ has: page.getByTestId('message-bubble-body').filter({ hasText: content }) })
async function edit(page: Page, oldContent: string, content: string) {
  const message = bubble(page, oldContent)
  await message.hover()
  await message.getByRole('button', { name: 'Message menu', exact: true }).click()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByRole('dialog', { name: 'Edit message' }).getByLabel('Message', { exact: true }).fill(content)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(bubble(page, content)).toBeVisible()
}
async function remove(page: Page, content: string) {
  const message = bubble(page, content)
  await message.hover()
  await message.getByRole('button', { name: 'Message menu', exact: true }).click()
  await page.getByRole('button', { name: 'Delete for everyone', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete for everyone', exact: true }).click()
  await expect(bubble(page, 'Message deleted')).toBeVisible()
}

test('edit history, deletion and privacy preference survive reload on desktop and mobile', async ({ page }) => {
  await start(page)
  await openPeer(page, 'c'.repeat(64))
  await page.getByPlaceholder('Type a message...').fill('Meet at seven')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await edit(page, 'Meet at seven', 'Meet at eight')
  await bubble(page, 'Meet at eight').getByRole('button', { name: 'Edit history' }).click()
  const history = page.getByRole('dialog', { name: 'Edit history' })
  await expect(history.getByText('Meet at seven', { exact: true })).toBeVisible()
  await expect(history.getByText('Meet at eight', { exact: true })).toBeVisible()
  await page.screenshot({ path: 'work/message-mutations/history-desktop.png' })
  await history.getByRole('button', { name: 'Close dialog' }).click()
  await page.reload()
  await page.getByTestId('sidebar-chat-list').getByRole('button').filter({ hasText: 'Meet at eight' }).click()
  await expect(bubble(page, 'Meet at eight')).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await bubble(page, 'Meet at eight').getByRole('button', { name: 'Edit history' }).click()
  await page.screenshot({ path: 'work/message-mutations/history-mobile.png' })
  await page.getByRole('button', { name: 'Close dialog' }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await remove(page, 'Meet at eight')
  await page.reload()
  if (!await bubble(page, 'Message deleted').isVisible()) await page.getByTestId('sidebar-chat-list').getByRole('button').first().click()
  await expect(bubble(page, 'Message deleted')).toBeVisible()
  await page.goto('/#settings/privacy')
  const preference = page.getByRole('switch', { name: 'Allow others to delete their messages' })
  await expect(preference).toHaveAttribute('aria-checked', 'true')
  await preference.click()
  await page.reload()
  await expect(preference).toHaveAttribute('aria-checked', 'false')
  await page.screenshot({ path: 'work/message-mutations/privacy-mobile.png' })
})

test('group messages use stable IDs for immediate edits and deletion', async ({ page }) => {
  await start(page)
  await openPeer(page, 'c'.repeat(64))
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page.getByRole('button', { name: 'Create Group', exact: true }).click()
  await page.getByTestId('create-group-member').first().click()
  await page.getByTestId('create-group-next').click()
  await page.getByPlaceholder('Enter group name...').fill('Weekend plans')
  await page.getByTestId('create-group-submit').click()
  await page.getByPlaceholder('Type a message...').fill('Bring lunch')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await edit(page, 'Bring lunch', 'Bring dinner')
  await expect(bubble(page, 'Bring dinner').getByRole('button', { name: 'Edit history' })).toBeVisible()
  await remove(page, 'Bring dinner')
  await page.reload()
  if (!await bubble(page, 'Message deleted').isVisible()) await page.getByTestId('sidebar-chat-list').getByRole('button').first().click()
  await expect(bubble(page, 'Message deleted')).toBeVisible()
})

test('encrypted peer edits arrive with history and recipient opt-out preserves a sender-deleted message', async ({ browser, page, testRelayUrl }) => {
  const context = await browser.newContext()
  await useTestRelay(context, testRelayUrl)
  const receiver = await context.newPage()
  try {
    await start(receiver)
    await receiver.getByRole('button', { name: 'New Chat', exact: true }).click()
    const invite = await receiver.locator('button[title*="#"]').first().getAttribute('title')
    if (!invite) throw new Error('Missing invite')
    await start(page)
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    await page.getByPlaceholder('Paste invite link').fill(invite)
    await page.getByPlaceholder('Type a message...').fill('See you Monday')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(async () => {
      for (const tab of [receiver.getByTestId('sidebar-tab-all'), receiver.getByTestId('sidebar-tab-requests')]) {
        await tab.click()
        const item = receiver.getByTestId('sidebar-chat-list').getByRole('button').filter({ hasText: 'See you Monday' }).first()
        if (await item.isVisible()) { await item.click(); return }
      }
      throw new Error('Waiting for incoming chat')
    }).toPass({ timeout: 30000 })
    await expect(bubble(receiver, 'See you Monday')).toBeVisible()
    await edit(page, 'See you Monday', 'See you Tuesday')
    await expect(bubble(receiver, 'See you Tuesday')).toBeVisible()
    await bubble(receiver, 'See you Tuesday').getByRole('button', { name: 'Edit history' }).click()
    await expect(receiver.getByRole('dialog').getByText('See you Monday', { exact: true })).toBeVisible()
    await receiver.getByRole('button', { name: 'Close dialog' }).click()
    const chatUrl = receiver.url()
    await receiver.goto('/#settings/privacy')
    await receiver.getByRole('switch', { name: 'Allow others to delete their messages' }).click()
    await receiver.goto(chatUrl)
    await reopen(receiver, 'See you Tuesday')
    await remove(page, 'See you Tuesday')
    await expect(bubble(receiver, 'See you Tuesday')).toBeVisible()
    // A subsequent encrypted message proves the receiver processed traffic after the ignored delete.
    await page.getByPlaceholder('Type a message...').fill('Next message')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(bubble(receiver, 'Next message')).toBeVisible()
    await receiver.reload()
    await reopen(receiver, 'Next message')
    await expect(bubble(receiver, 'See you Tuesday')).toBeVisible()
    await receiver.goto('/#settings/privacy')
    await receiver.getByRole('switch', { name: 'Allow others to delete their messages' }).click()
    await receiver.goto(chatUrl)
    await reopen(receiver, 'Next message')
    await remove(page, 'Next message')
    await expect(bubble(receiver, 'Message deleted')).toBeVisible()
    await page.getByPlaceholder('Type a message...').fill('Keep sender copy')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const localOnly = bubble(receiver, 'Keep sender copy')
    await expect(localOnly).toBeVisible()
    await localOnly.hover()
    await localOnly.getByRole('button', { name: 'Message menu', exact: true }).click()
    await receiver.getByRole('button', { name: 'Delete for me', exact: true }).click()
    await expect(localOnly).toHaveCount(0)
    await expect(bubble(page, 'Keep sender copy')).toBeVisible()
    await edit(page, 'Keep sender copy', 'Keep sender correction')
    await page.getByPlaceholder('Type a message...').fill('After local deletion')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(bubble(receiver, 'After local deletion')).toBeVisible()
    await receiver.reload()
    await reopen(receiver, 'After local deletion')
    await expect(bubble(receiver, 'Keep sender')).toHaveCount(0)
    await expect(bubble(page, 'Keep sender correction')).toBeVisible()
  } finally { await context.close() }
})

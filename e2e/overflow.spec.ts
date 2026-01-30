import { test, expect, useTestRelay } from './fixtures'

test.describe('Message overflow', () => {
  test('long text and reply previews should not overflow container', async ({ browser, testRelayUrl }) => {
    const context1 = await browser.newContext()
    await useTestRelay(context1, testRelayUrl)
    const context2 = await browser.newContext()
    await useTestRelay(context2, testRelayUrl)

    const page1 = await context1.newPage()
    const page2 = await context2.newPage()

    try {
      // User 1: Login and create invite
      await page1.goto('/')
      await page1.getByRole('button', { name: 'Go' }).click()
      await page1.getByRole('button', { name: 'New Chat' }).click()

      const copyButton = page1.locator('button[title*="#"]').first()
      await expect(copyButton).toBeVisible()
      const rawInviteUrl = await copyButton.getAttribute('title')
      if (!rawInviteUrl) throw new Error('Could not get invite URL')
      const inviteUrl = rawInviteUrl.replace('https://chat.iris.to', 'http://localhost:4173')

      // User 2: Join via paste link
      await page2.goto('/')
      await page2.getByRole('button', { name: 'Go' }).click()
      await page2.getByRole('button', { name: 'New Chat' }).click()
      await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

      await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
      await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

      const viewportSize = page1.viewportSize()!

      // --- Test 1: Long nhash from other user (received, left-aligned) ---
      const longNhash = 'nhash1qqsrpw0pysrwnxjuwscg0vh2sectsdustpkq9hnre6qux9r9yc3wcxg9yq88a9mc1zye0p6ju465w8y49350abcdef1234567890'
      await page2.getByPlaceholder('Type a message...').fill(longNhash)
      await page2.getByRole('button', { name: 'Send' }).click()

      const receivedMsg = page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'nhash1qq' })
      await expect(receivedMsg).toBeVisible()

      const box1 = await receivedMsg.boundingBox()
      expect(box1).toBeTruthy()
      expect(box1!.x + box1!.width).toBeLessThanOrEqual(viewportSize.width)

      await page1.screenshot({ path: 'test-results/overflow-received-long.png', fullPage: true })

      // --- Test 2: Long nhash from own user (sent, right-aligned) ---
      await page1.getByPlaceholder('Type a message...').fill(longNhash)
      await page1.getByRole('button', { name: 'Send' }).click()

      // Wait for own message to render
      const ownMsgs = page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'nhash1qq' })
      await expect(ownMsgs.nth(1)).toBeVisible()

      const box2 = await ownMsgs.nth(1).boundingBox()
      expect(box2).toBeTruthy()
      expect(box2!.x + box2!.width).toBeLessThanOrEqual(viewportSize.width)

      await page1.screenshot({ path: 'test-results/overflow-own-long.png', fullPage: true })

      // --- Test 3: Reply with long nhash to a long nhash (own message with reply preview) ---
      // User 1 replies to the received long nhash
      const firstMsg = page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'nhash1qq' }).first()
      await firstMsg.hover()
      await firstMsg.getByLabel('Reply').click()
      const replyText = 'nhash1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'
      await page1.getByPlaceholder('Type a message...').fill(replyText)
      await page1.getByRole('button', { name: 'Send' }).click()

      // Own reply message with reply preview
      const replyMsg = page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'nhash1zz' })
      await expect(replyMsg).toBeVisible()

      const box3 = await replyMsg.boundingBox()
      expect(box3).toBeTruthy()
      expect(box3!.x + box3!.width).toBeLessThanOrEqual(viewportSize.width)
      expect(box3!.x).toBeGreaterThanOrEqual(0)

      await page1.screenshot({ path: 'test-results/overflow-own-reply.png', fullPage: true })

      // --- Test 4: Hover own reply to show action buttons ---
      await replyMsg.hover()
      await page1.waitForTimeout(300)

      const box4 = await replyMsg.boundingBox()
      expect(box4).toBeTruthy()
      expect(box4!.x + box4!.width).toBeLessThanOrEqual(viewportSize.width)

      await page1.screenshot({ path: 'test-results/overflow-own-reply-hover.png', fullPage: true })

    } finally {
      await context1.close()
      await context2.close()
    }
  })
})

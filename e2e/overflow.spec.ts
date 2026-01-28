import { test, expect, useTestRelay } from './fixtures'

test.describe('Message overflow', () => {
  test('long text without spaces should not overflow container', async ({ browser, testRelay }) => {
    const context1 = await browser.newContext()
    await useTestRelay(context1, testRelay.url)
    const context2 = await browser.newContext()
    await useTestRelay(context2, testRelay.url)

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
      const inviteUrl = rawInviteUrl.replace('https://chat.iris.to', 'http://localhost:5173')

      // User 2: Join via paste link
      await page2.goto('/')
      await page2.getByRole('button', { name: 'Go' }).click()
      await page2.getByRole('button', { name: 'New Chat' }).click()
      await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

      await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
      await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

      // User 2 sends a very long message without spaces
      const longMessage = 'ABCD'.repeat(50) // 200 chars without spaces
      await page2.getByPlaceholder('Type a message...').fill(longMessage)
      await page2.getByRole('button', { name: 'Send' }).click()

      // Wait for message to appear on page1
      await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'ABCD' })).toBeVisible()

      // Take screenshot for visual verification
      await page1.screenshot({ path: 'test-results/overflow-test.png', fullPage: true })

      // Check that the message bubble doesn't overflow its container
      const messageBubble = page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'ABCD' })
      const bubbleBox = await messageBubble.boundingBox()
      const viewportSize = page1.viewportSize()
      
      if (bubbleBox && viewportSize) {
        // Message should not extend beyond 85% of viewport + some padding
        const maxAllowedWidth = viewportSize.width * 0.85 + 50 // some tolerance
        expect(bubbleBox.width).toBeLessThan(maxAllowedWidth)
        
        // Message should not extend past the right edge
        expect(bubbleBox.x + bubbleBox.width).toBeLessThan(viewportSize.width)
      }

    } finally {
      await context1.close()
      await context2.close()
    }
  })
})

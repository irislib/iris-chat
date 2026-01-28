import { test, expect, type Page, type BrowserContext } from '@playwright/test'

// Helper to get invite URL from CopyButton (has title attribute with full URL)
// Rewrites chat.iris.to URLs to localhost for e2e tests
async function getInviteUrl(page: Page): Promise<string> {
  const copyButton = page.locator('button[title*="#"]').first()
  await expect(copyButton).toBeVisible()
  const url = await copyButton.getAttribute('title')
  if (!url) throw new Error('Could not get invite URL')
  // Rewrite production URL to test server (invite URLs use chat.iris.to on localhost)
  return url.replace('https://chat.iris.to', 'http://localhost:5173')
}

// Helper to setup a user and get their invite URL
async function setupUserWithInvite(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Go' }).click()
  await page.getByRole('button', { name: 'New Chat' }).click()
  // Invite is auto-created, just get the URL
  return getInviteUrl(page)
}

test.describe('iris chat', () => {
  test.describe('Chat input', () => {
    test('should focus input when opening or switching chat', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()
      const context3 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()
      const page3 = await context3.newPage()

      try {
        // Setup: User 1 creates first chat (invite auto-created)
        const inviteUrl1 = await setupUserWithInvite(page1)

        // User 2 joins first chat
        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await page2.getByPlaceholder('Paste invite link').fill(inviteUrl1)

        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

        // Input should be focused when chat opens
        const input = page1.getByPlaceholder('Type a message...')
        await expect(input).toBeFocused()

        // User 2 sends a message so chat has content
        await page2.getByPlaceholder('Type a message...').fill('Hello')
        await page2.getByRole('button', { name: 'Send' }).click()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Hello' })).toBeVisible()

        // User 1 goes back to sidebar
        await page1.getByRole('button', { name: 'Back' }).click()

        // Create second invite
        await page1.getByRole('button', { name: 'New Chat' }).click()
        await page1.getByRole('button', { name: 'Create New Invite' }).click()
        // Get the second invite URL (newest one)
        const inviteUrl2 = await getInviteUrl(page1)

        // User 3 joins second chat
        await page3.goto('/')
        await page3.getByRole('button', { name: 'Go' }).click()
        await page3.getByRole('button', { name: 'New Chat' }).click()
        await page3.getByPlaceholder('Paste invite link').fill(inviteUrl2)

        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

        // Input should be focused when second chat opens
        await expect(page1.getByPlaceholder('Type a message...')).toBeFocused()

        // Go back and click on first chat
        await page1.getByRole('button', { name: 'Back' }).click()
        await page1.locator('button').filter({ hasText: 'Hello' }).click()

        // Input should be focused when switching to first chat
        await expect(page1.getByPlaceholder('Type a message...')).toBeFocused()
      } finally {
        await context1.close()
        await context2.close()
        await context3.close()
      }
    })

    test('should persist own messages across reload', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // Setup: Create chat between two users
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Go' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        const inviteUrl = await getInviteUrl(page1)

        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

        // User 2 sends first to establish connection
        await page2.getByPlaceholder('Type a message...').fill('Hello there')
        await page2.getByRole('button', { name: 'Send' }).click()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Hello there' })).toBeVisible()

        // User 2 sends their own message
        await page2.getByPlaceholder('Type a message...').fill('My own message')
        await page2.getByRole('button', { name: 'Send' }).click()
        await expect(page2.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'My own message' })).toBeVisible()

        // User 2 goes back and reloads
        await page2.getByRole('button', { name: 'Back' }).click()
        await page2.reload()

        // Should see chat in list with own message preview
        await expect(page2.getByText('My own message')).toBeVisible()

        // Open the chat by clicking on it
        await page2.locator('button').filter({ hasText: 'My own message' }).click()

        // Should see both messages including own message
        await expect(page2.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Hello there' })).toBeVisible()
        await expect(page2.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'My own message' })).toBeVisible()
      } finally {
        await context1.close()
        await context2.close()
      }
    })

    test('should unfocus input on Escape key', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // Setup: Create chat between two users
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Go' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        const inviteUrl = await getInviteUrl(page1)

        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

        const input = page1.getByPlaceholder('Type a message...')

        // Focus the input
        await input.focus()
        await expect(input).toBeFocused()

        // Press Escape
        await page1.keyboard.press('Escape')

        // Input should be unfocused
        await expect(input).not.toBeFocused()
      } finally {
        await context1.close()
        await context2.close()
      }
    })

    test('should keep focus in input after sending message', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // Setup: Create chat between two users
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Go' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        const inviteUrl = await getInviteUrl(page1)

        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

        // User 2 sends first to establish connection
        await page2.getByPlaceholder('Type a message...').fill('Hi')
        await page2.getByRole('button', { name: 'Send' }).click()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Hi' })).toBeVisible()

        // Get the input element for User 1
        const input = page1.getByPlaceholder('Type a message...')

        // Focus the input first
        await input.focus()

        // Send a message
        await input.fill('Test message')
        await page1.getByRole('button', { name: 'Send' }).click()

        // Wait for message to appear
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Test message' })).toBeVisible()

        // Check that input is still focused
        await expect(input).toBeFocused()
      } finally {
        await context1.close()
        await context2.close()
      }
    })

    test('should persist message drafts per chat when switching', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()
      const context3 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()
      const page3 = await context3.newPage()

      try {
        // User 1 creates first chat
        const inviteUrl1 = await setupUserWithInvite(page1)

        // User 2 joins first chat
        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await page2.getByPlaceholder('Paste invite link').fill(inviteUrl1)

        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

        // User 2 sends a message so chat appears in sidebar
        await page2.getByPlaceholder('Type a message...').fill('Chat one')
        await page2.getByRole('button', { name: 'Send' }).click()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Chat one' })).toBeVisible()

        // User 1 types a draft in chat 1 (but does NOT send)
        await page1.getByPlaceholder('Type a message...').fill('Draft for chat one')

        // User 1 goes back to create second chat
        await page1.getByRole('button', { name: 'Back' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        await page1.getByRole('button', { name: 'Create New Invite' }).click()
        const inviteUrl2 = await getInviteUrl(page1)

        // User 3 joins second chat
        await page3.goto('/')
        await page3.getByRole('button', { name: 'Go' }).click()
        await page3.getByRole('button', { name: 'New Chat' }).click()
        await page3.getByPlaceholder('Paste invite link').fill(inviteUrl2)

        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

        // User 3 sends a message so chat 2 appears in sidebar
        await page3.getByPlaceholder('Type a message...').fill('Chat two')
        await page3.getByRole('button', { name: 'Send' }).click()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Chat two' })).toBeVisible()

        // User 1 types a draft in chat 2
        await page1.getByPlaceholder('Type a message...').fill('Draft for chat two')

        // Switch back to chat 1
        await page1.getByRole('button', { name: 'Back' }).click()
        await page1.locator('button').filter({ hasText: 'Chat one' }).click()

        // Draft for chat 1 should be restored
        await expect(page1.getByPlaceholder('Type a message...')).toHaveValue('Draft for chat one')

        // Switch back to chat 2
        await page1.getByRole('button', { name: 'Back' }).click()
        await page1.locator('button').filter({ hasText: 'Chat two' }).click()

        // Draft for chat 2 should be restored
        await expect(page1.getByPlaceholder('Type a message...')).toHaveValue('Draft for chat two')
      } finally {
        await context1.close()
        await context2.close()
        await context3.close()
      }
    })
  })

  test.describe('Login', () => {
    test('should show login page initially', async ({ page }) => {
      await page.goto('/')
      await expect(page.getByText('iris chat')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Go' })).toBeVisible()
    })

    test('should login and show home view', async ({ page }) => {
      await page.goto('/')
      await page.getByRole('button', { name: 'Go' }).click()

      // Should show sidebar with New Chat button
      await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible()
    })

    test('should persist login across page reload', async ({ page }) => {
      await page.goto('/')
      await page.getByRole('button', { name: 'Go' }).click()
      await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible()

      // Reload page
      await page.reload()

      // Should still be logged in
      await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible()
    })
  })

  test.describe('Invite', () => {
    test('should auto-create invite and show link', async ({ page }) => {
      await page.goto('/')
      await page.getByRole('button', { name: 'Go' }).click()
      await page.getByRole('button', { name: 'New Chat' }).click()

      // Should auto-create invite with default label
      await expect(page.getByText('Invite #1')).toBeVisible()
      // Should show copy button with URL
      await expect(page.locator('button[title*="#"]')).toBeVisible()
    })

    test('should copy invite link', async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])

      await page.goto('/')
      await page.getByRole('button', { name: 'Go' }).click()
      await page.getByRole('button', { name: 'New Chat' }).click()

      // Click copy button (has the URL in title)
      await page.locator('button[title*="#"]').click()

      // Should show checkmark after copy
      await expect(page.locator('button:has(.i-carbon-checkmark)')).toBeVisible()

      // Verify clipboard contains invite URL
      const clipboardText = await page.evaluate(() => navigator.clipboard.readText())
      expect(clipboardText).toContain('http')
      expect(clipboardText).toContain('#')
    })
  })

  test.describe('Chat menu', () => {
    test('should delete chat from header menu', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // Setup: Create chat between two users
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Go' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        const inviteUrl = await getInviteUrl(page1)

        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

        // Send a message so chat has content
        await page2.getByPlaceholder('Type a message...').fill('Hello')
        await page2.getByRole('button', { name: 'Send' }).click()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Hello' })).toBeVisible()

        // Click the menu button in header
        await page1.getByRole('button', { name: 'Chat menu' }).click()

        // Click delete option
        await page1.getByRole('button', { name: 'Delete chat' }).click()

        // Should go back to sidebar/home and chat should be gone
        await expect(page1.getByRole('button', { name: 'New Chat' })).toBeVisible()
        await expect(page1.getByText('Hello')).not.toBeVisible()
      } finally {
        await context1.close()
        await context2.close()
      }
    })
  })

  test.describe('Message menu', () => {
    test('should delete message locally via context menu', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // Setup: Create chat between two users
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Go' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        const inviteUrl = await getInviteUrl(page1)

        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

        // User 2 sends two messages
        await page2.getByPlaceholder('Type a message...').fill('First message')
        await page2.getByRole('button', { name: 'Send' }).click()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'First message' })).toBeVisible()

        await page2.getByPlaceholder('Type a message...').fill('Second message')
        await page2.getByRole('button', { name: 'Send' }).click()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Second message' })).toBeVisible()

        // User 1 hovers over first message to reveal menu
        const messageBubble = page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'First message' })
        await messageBubble.hover()

        // Click the menu button
        await page1.locator('button[aria-label="Message menu"]').first().click()

        // Click delete option
        await page1.getByRole('button', { name: 'Delete for you' }).click()

        // First message should be gone, second message should remain
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'First message' })).not.toBeVisible()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Second message' })).toBeVisible()

        // User 2 should still see both messages (delete is local only)
        await expect(page2.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'First message' })).toBeVisible()
        await expect(page2.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Second message' })).toBeVisible()
      } finally {
        await context1.close()
        await context2.close()
      }
    })

    test('should copy message via context menu', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      await context1.grantPermissions(['clipboard-read', 'clipboard-write'])

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // Setup: Create chat between two users
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Go' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        const inviteUrl = await getInviteUrl(page1)

        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

        // User 2 sends a message
        await page2.getByPlaceholder('Type a message...').fill('Copy this text')
        await page2.getByRole('button', { name: 'Send' }).click()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Copy this text' })).toBeVisible()

        // User 1 hovers over message to reveal menu
        const messageBubble = page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Copy this text' })
        await messageBubble.hover()

        // Click the menu button
        await page1.locator('button[aria-label="Message menu"]').first().click()

        // Click copy option (use exact match to avoid sidebar copy button)
        await page1.getByRole('button', { name: 'Copy', exact: true }).click()

        // Verify clipboard contains the message text
        const clipboardText = await page1.evaluate(() => navigator.clipboard.readText())
        expect(clipboardText).toBe('Copy this text')
      } finally {
        await context1.close()
        await context2.close()
      }
    })
  })

  test.describe('Media modal', () => {
    test('should open image in modal overlay when clicked', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // Setup: Create chat between two users
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Go' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        const inviteUrl = await getInviteUrl(page1)

        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

        // User 2 sends a message with a fake image nhash
        const fakeNhash = 'nhash1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr5thfd'
        await page2.getByPlaceholder('Type a message...').fill(`${fakeNhash}/test.jpg`)
        await page2.getByRole('button', { name: 'Send' }).click()

        // Wait for file attachment to appear
        await expect(page1.locator('.file-attachment')).toBeVisible()

        // Modal should not be visible initially
        await expect(page1.locator('[data-testid="media-modal"]')).not.toBeVisible()

        // Click the image (will show error state but modal should still open)
        await page1.locator('.file-attachment button').first().click()

        // Modal overlay should appear
        await expect(page1.locator('[data-testid="media-modal"]')).toBeVisible()
      } finally {
        await context1.close()
        await context2.close()
      }
    })

    test('should close modal when clicking backdrop', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // Setup
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Go' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        const inviteUrl = await getInviteUrl(page1)

        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

        // Send image link
        const fakeNhash = 'nhash1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr5thfd'
        await page2.getByPlaceholder('Type a message...').fill(`${fakeNhash}/test.jpg`)
        await page2.getByRole('button', { name: 'Send' }).click()

        await expect(page1.locator('.file-attachment')).toBeVisible()

        // Open modal
        await page1.locator('.file-attachment button').first().click()
        await expect(page1.locator('[data-testid="media-modal"]')).toBeVisible()

        // Click backdrop to close (click in corner to avoid content)
        await page1.locator('[data-testid="media-modal-backdrop"]').click({ position: { x: 10, y: 10 } })
        await expect(page1.locator('[data-testid="media-modal"]')).not.toBeVisible()
      } finally {
        await context1.close()
        await context2.close()
      }
    })

    test('should close modal when pressing Escape', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // Setup
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Go' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        const inviteUrl = await getInviteUrl(page1)

        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

        // Send image link
        const fakeNhash = 'nhash1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr5thfd'
        await page2.getByPlaceholder('Type a message...').fill(`${fakeNhash}/test.jpg`)
        await page2.getByRole('button', { name: 'Send' }).click()

        await expect(page1.locator('.file-attachment')).toBeVisible()

        // Open modal
        await page1.locator('.file-attachment button').first().click()
        await expect(page1.locator('[data-testid="media-modal"]')).toBeVisible()

        // Press Escape to close
        await page1.keyboard.press('Escape')
        await expect(page1.locator('[data-testid="media-modal"]')).not.toBeVisible()
      } finally {
        await context1.close()
        await context2.close()
      }
    })

    test('should have close button in modal', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // Setup
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Go' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        const inviteUrl = await getInviteUrl(page1)

        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

        // Send image link
        const fakeNhash = 'nhash1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr5thfd'
        await page2.getByPlaceholder('Type a message...').fill(`${fakeNhash}/test.jpg`)
        await page2.getByRole('button', { name: 'Send' }).click()

        await expect(page1.locator('.file-attachment')).toBeVisible()

        // Open modal
        await page1.locator('.file-attachment button').first().click()
        await expect(page1.locator('[data-testid="media-modal"]')).toBeVisible()

        // Click close button
        await page1.getByRole('button', { name: 'Close' }).click()
        await expect(page1.locator('[data-testid="media-modal"]')).not.toBeVisible()
      } finally {
        await context1.close()
        await context2.close()
      }
    })
  })

  test.describe('File attachments', () => {
    test('should show attachment button in chat', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // Setup: Create chat between two users
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Go' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        const inviteUrl = await getInviteUrl(page1)

        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

        // Attachment button should be visible
        await expect(page1.getByRole('button', { name: 'Attach file' })).toBeVisible()
      } finally {
        await context1.close()
        await context2.close()
      }
    })

    test('should display file attachment when nhash link is in message', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // Setup: Create chat between two users
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Go' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        const inviteUrl = await getInviteUrl(page1)

        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

        // User 2 sends a message with a fake nhash link (will try to load and fail gracefully)
        // Using a valid-looking nhash format but fake hash
        const fakeNhash = 'nhash1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr5thfd'
        await page2.getByPlaceholder('Type a message...').fill(`${fakeNhash}/test-image.jpg`)
        await page2.getByRole('button', { name: 'Send' }).click()

        // The file attachment component should appear (loading or error state)
        // Look for the file-attachment div that wraps the content
        await expect(page1.locator('.file-attachment')).toBeVisible()
      } finally {
        await context1.close()
        await context2.close()
      }
    })
  })

  test.describe('Reactions', () => {
    test('should persist reactions across reload', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // Setup: Create chat between two users
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Go' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        const inviteUrl = await getInviteUrl(page1)

        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

        // User 2 sends a message
        await page2.getByPlaceholder('Type a message...').fill('React to this!')
        await page2.getByRole('button', { name: 'Send' }).click()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'React to this!' })).toBeVisible()

        // User 1 adds a reaction
        const messageBubble = page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'React to this!' })
        await messageBubble.hover()
        await page1.locator('button[aria-label="Add reaction"]').click()
        await page1.getByRole('button', { name: '❤️' }).click()

        // Reaction should appear
        await expect(page1.locator('.reaction').filter({ hasText: '❤️' })).toBeVisible()

        // User 1 goes back and reloads
        await page1.getByRole('button', { name: 'Back' }).click()
        await page1.reload()

        // Open the chat again
        await page1.locator('button').filter({ hasText: 'React to this!' }).click()

        // Wait for chat to load
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'React to this!' })).toBeVisible()

        // Reaction should still be there
        await expect(page1.locator('.reaction').filter({ hasText: '❤️' })).toBeVisible()
      } finally {
        await context1.close()
        await context2.close()
      }
    })

    test('should sync reaction to other user', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      page1.on('console', msg => console.log('PAGE1:', msg.text()))
      page2.on('console', msg => console.log('PAGE2:', msg.text()))

      try {
        // Setup: Create chat between two users
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Go' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        const inviteUrl = await getInviteUrl(page1)

        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

        // User 2 sends a message
        await page2.getByPlaceholder('Type a message...').fill('React to this!')
        await page2.getByRole('button', { name: 'Send' }).click()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'React to this!' })).toBeVisible()

        // User 1 adds a reaction
        const messageBubble = page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'React to this!' })
        await messageBubble.hover()
        await page1.locator('button[aria-label="Add reaction"]').click()
        await page1.getByRole('button', { name: '❤️' }).click()

        // Reaction should appear on User 1
        await expect(page1.locator('.reaction').filter({ hasText: '❤️' })).toBeVisible()

        // Reaction should sync to User 2
        await expect(page2.locator('.reaction').filter({ hasText: '❤️' })).toBeVisible()
      } finally {
        await context1.close()
        await context2.close()
      }
    })

    test('should add reaction to message on click', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // Setup: Create chat between two users
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Go' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        const inviteUrl = await getInviteUrl(page1)

        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

        // User 2 sends a message
        await page2.getByPlaceholder('Type a message...').fill('React to this!')
        await page2.getByRole('button', { name: 'Send' }).click()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'React to this!' })).toBeVisible()

        // User 1 hovers over the message to reveal reaction button
        const messageBubble = page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'React to this!' })
        await messageBubble.hover()

        // Click the reaction button
        await page1.locator('button[aria-label="Add reaction"]').click()

        // Click a reaction emoji (heart)
        await page1.getByRole('button', { name: '❤️' }).click()

        // Reaction should appear on User 1's screen
        await expect(page1.locator('.reaction').filter({ hasText: '❤️' })).toBeVisible()
      } finally {
        await context1.close()
        await context2.close()
      }
    })

    test('should allow only one reaction per user (latest wins)', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // Setup: Create chat between two users
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Go' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        const inviteUrl = await getInviteUrl(page1)

        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

        // User 2 sends a message
        await page2.getByPlaceholder('Type a message...').fill('React to this!')
        await page2.getByRole('button', { name: 'Send' }).click()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'React to this!' })).toBeVisible()

        // User 1 reacts with heart
        const messageBubble = page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'React to this!' })
        await messageBubble.hover()
        await page1.locator('button[aria-label="Add reaction"]').click()
        await page1.getByRole('button', { name: '❤️' }).click()
        await expect(page1.locator('.reaction').filter({ hasText: '❤️' })).toBeVisible()

        // User 1 reacts again with thumbs up (should replace heart)
        await messageBubble.hover()
        await page1.locator('button[aria-label="Add reaction"]').click()
        await page1.getByRole('button', { name: '👍' }).click()

        // Only thumbs up should be visible, heart should be gone
        await expect(page1.locator('.reaction').filter({ hasText: '👍' })).toBeVisible()
        await expect(page1.locator('.reaction').filter({ hasText: '❤️' })).not.toBeVisible()
      } finally {
        await context1.close()
        await context2.close()
      }
    })
  })

  test.describe('Profile page', () => {
    test('should navigate to profile page when clicking avatar in chat header', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // User 1: Enter name "Alice" and login
        await page1.goto('/')
        await page1.getByPlaceholder('Name').fill('Alice')
        await page1.getByRole('button', { name: 'Go' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        const inviteUrl = await getInviteUrl(page1)

        // User 2: Enter name "Bob" and join
        await page2.goto('/')
        await page2.getByPlaceholder('Name').fill('Bob')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

        // Both in chat view
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

        // User 2 sends a message to establish connection
        await page2.getByPlaceholder('Type a message...').fill('Hi!')
        await page2.getByRole('button', { name: 'Send' }).click()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Hi!' })).toBeVisible()

        // User 1 clicks on avatar/name button in header to view profile
        // The button wraps both avatar and name in the header
        const profileButton = page1.locator('header button').filter({ hasText: 'Bob' }).first()
        await expect(profileButton).toBeEnabled()
        await profileButton.click()

        // Should navigate to profile page
        await expect(page1.getByRole('heading', { name: 'Profile' })).toBeVisible()
        await expect(page1.getByRole('heading', { name: 'Bob' })).toBeVisible()
        // CopyButton shows truncated npub string
        await expect(page1.locator('button').filter({ hasText: 'npub1' })).toBeVisible()
        await expect(page1.getByRole('button', { name: 'Open Chat' })).toBeVisible()

        // URL should have profile hash
        expect(page1.url()).toContain('#profile-')

        // Click back button
        await page1.getByRole('button', { name: 'Back' }).click()

        // Should be back in chat view
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
      } finally {
        await context1.close()
        await context2.close()
      }
    })

    test('should open existing chat from profile page', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // Setup chat between two users
        await page1.goto('/')
        await page1.getByPlaceholder('Name').fill('Alice')
        await page1.getByRole('button', { name: 'Go' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        const inviteUrl = await getInviteUrl(page1)

        await page2.goto('/')
        await page2.getByPlaceholder('Name').fill('Bob')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

        // Send message to establish connection
        await page2.getByPlaceholder('Type a message...').fill('Test')
        await page2.getByRole('button', { name: 'Send' }).click()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Test' })).toBeVisible()

        // Go to profile page
        await page1.locator('header').getByText('Bob').click()
        await expect(page1.getByRole('heading', { name: 'Profile' })).toBeVisible()

        // Click "Open Chat" button
        await page1.getByRole('button', { name: 'Open Chat' }).click()

        // Should be back in chat view with messages
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Test' })).toBeVisible()
      } finally {
        await context1.close()
        await context2.close()
      }
    })
  })

  test.describe('Two-user chat', () => {
    test('should allow two users to chat via URL', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // User 1: Login and create invite (auto-created)
        const inviteUrl = await setupUserWithInvite(page1)

        // User 2: Navigate to invite URL first (will need to login)
        await page2.goto(inviteUrl)

        // Should show login page first (button says "Join Chat" when invite in URL)
        await expect(page2.getByRole('button', { name: 'Join Chat' })).toBeVisible()
        await page2.getByRole('button', { name: 'Join Chat' }).click()

        // After login, JoinChat component auto-joins from URL hash
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

        // User 2 sends a message
        await page2.getByPlaceholder('Type a message...').fill('Hello from User 2!')
        await page2.getByRole('button', { name: 'Send' }).click()

        // Both users should see the message in chat bubbles
        await expect(page2.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Hello from User 2!' })).toBeVisible()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Hello from User 2!' })).toBeVisible()

        // User 1 replies
        await page1.getByPlaceholder('Type a message...').fill('Hello from User 1!')
        await page1.getByRole('button', { name: 'Send' }).click()

        // Both users should see the reply
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Hello from User 1!' })).toBeVisible()
        await expect(page2.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Hello from User 1!' })).toBeVisible()
      } finally {
        await context1.close()
        await context2.close()
      }
    })

    test('should allow two users to chat via paste link', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // User 1: Login and create invite (auto-created)
        const inviteUrl = await setupUserWithInvite(page1)

        // User 2: Login and join via paste link
        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()

        // Paste the link in the Join Chat input
        await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

        // User 2 should be in chat view (auto-joins on valid paste)
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

        // User 2 sends a message
        await page2.getByPlaceholder('Type a message...').fill('Hello via paste!')
        await page2.getByRole('button', { name: 'Send' }).click()

        // Both users should see the message
        await expect(page2.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Hello via paste!' })).toBeVisible()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Hello via paste!' })).toBeVisible()

        // User 1 replies
        await page1.getByPlaceholder('Type a message...').fill('Got it!')
        await page1.getByRole('button', { name: 'Send' }).click()

        // Both users should see the reply
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Got it!' })).toBeVisible()
        await expect(page2.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Got it!' })).toBeVisible()
      } finally {
        await context1.close()
        await context2.close()
      }
    })

    test('should persist chat session across page reload', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // User 1: Login and create invite (auto-created)
        const inviteUrl = await setupUserWithInvite(page1)

        // User 2: Login and join via paste link
        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

        // Both in chat view
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

        // User 2 sends first message to establish connection
        await page2.getByPlaceholder('Type a message...').fill('Hello!')
        await page2.getByRole('button', { name: 'Send' }).click()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Hello!' })).toBeVisible()

        // User 1 sends message before reload
        await page1.getByPlaceholder('Type a message...').fill('Before reload')
        await page1.getByRole('button', { name: 'Send' }).click()
        // Wait for User 1 to see their own message (ensures UI updated)
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Before reload' })).toBeVisible()
        await expect(page2.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Before reload' })).toBeVisible()

        // User 1 goes back
        await page1.getByRole('button', { name: 'Back' }).click()
        // Verify sidebar shows the message preview before reload
        await expect(page1.getByText('Before reload')).toBeVisible()
        // Small delay to ensure IndexedDB async save completes
        await page1.waitForTimeout(200)

        // Reload page 1
        await page1.reload()

        // Should still be logged in and see chat in sidebar
        await expect(page1.getByRole('button', { name: 'New Chat' })).toBeVisible()

        // Should see the chat in the list with message preview
        await expect(page1.getByText('Before reload')).toBeVisible()

        // Click on the chat to open it
        await page1.locator('button').filter({ hasText: 'Before reload' }).click()

        // Should be back in chat view with the message
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Before reload' })).toBeVisible()

        // User 2 sends a message after User 1 reloaded
        await page2.getByPlaceholder('Type a message...').fill('After reload')
        await page2.getByRole('button', { name: 'Send' }).click()

        // User 1 should receive the message (session was restored)
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'After reload' })).toBeVisible()

        // User 1 should be able to reply
        await page1.getByPlaceholder('Type a message...').fill('Reply after reload')
        await page1.getByRole('button', { name: 'Send' }).click()

        // User 2 should receive it
        await expect(page2.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Reply after reload' })).toBeVisible()
      } finally {
        await context1.close()
        await context2.close()
      }
    })

    test('should display each others names in chat', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // User 1: Enter name "Alice" and login
        await page1.goto('/')
        await page1.getByPlaceholder('Name').fill('Alice')
        await page1.getByRole('button', { name: 'Go' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        const inviteUrl = await getInviteUrl(page1)

        // User 2: Enter name "Bob" and join
        await page2.goto('/')
        await page2.getByPlaceholder('Name').fill('Bob')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await page2.getByPlaceholder('Paste invite link').fill(inviteUrl)

        // Both in chat view
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

        // User 2 sends a message to establish connection
        await page2.getByPlaceholder('Type a message...').fill('Hi!')
        await page2.getByRole('button', { name: 'Send' }).click()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Hi!' })).toBeVisible()

        // User 1 should see "Bob" in chat header
        await expect(page1.locator('header').getByText('Bob')).toBeVisible()

        // User 2 should see "Alice" in chat header
        await expect(page2.locator('header').getByText('Alice')).toBeVisible()
      } finally {
        await context1.close()
        await context2.close()
      }
    })
  })
})

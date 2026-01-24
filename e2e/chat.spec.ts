import { test, expect, type Page, type BrowserContext } from '@playwright/test'

test.describe('iris chat', () => {
  test.describe('Chat input', () => {
    test('should persist own messages across reload', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // Setup: Create chat between two users
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Get Started' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        await page1.getByRole('button', { name: 'Create Invite' }).click()
        const inviteUrl = await page1.locator('input[readonly]').inputValue()

        await page2.goto('/')
        await page2.getByRole('button', { name: 'Get Started' }).click()
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
        await page1.getByRole('button', { name: 'Get Started' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        await page1.getByRole('button', { name: 'Create Invite' }).click()
        const inviteUrl = await page1.locator('input[readonly]').inputValue()

        await page2.goto('/')
        await page2.getByRole('button', { name: 'Get Started' }).click()
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
        await page1.getByRole('button', { name: 'Get Started' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        await page1.getByRole('button', { name: 'Create Invite' }).click()
        const inviteUrl = await page1.locator('input[readonly]').inputValue()

        await page2.goto('/')
        await page2.getByRole('button', { name: 'Get Started' }).click()
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
  })

  test.describe('Login', () => {
    test('should show login page initially', async ({ page }) => {
      await page.goto('/')
      await expect(page.getByText('iris chat')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Get Started' })).toBeVisible()
    })

    test('should login and show home view', async ({ page }) => {
      await page.goto('/')
      await page.getByRole('button', { name: 'Get Started' }).click()

      // Should show sidebar with New Chat button
      await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible()
    })

    test('should persist login across page reload', async ({ page }) => {
      await page.goto('/')
      await page.getByRole('button', { name: 'Get Started' }).click()
      await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible()

      // Reload page
      await page.reload()

      // Should still be logged in
      await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible()
    })
  })

  test.describe('Invite', () => {
    test('should create invite and show link', async ({ page }) => {
      await page.goto('/')
      await page.getByRole('button', { name: 'Get Started' }).click()
      await page.getByRole('button', { name: 'New Chat' }).click()
      await page.getByRole('button', { name: 'Create Invite' }).click()

      // Should show invite URL in input and waiting message
      await expect(page.getByText('Waiting for someone to join')).toBeVisible()
      await expect(page.locator('input[readonly]')).toBeVisible()
    })

    test('should copy invite link', async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])

      await page.goto('/')
      await page.getByRole('button', { name: 'Get Started' }).click()
      await page.getByRole('button', { name: 'New Chat' }).click()
      await page.getByRole('button', { name: 'Create Invite' }).click()

      // Click copy button (icon button)
      await page.locator('button:has(.i-carbon-copy)').click()

      // Should show checkmark after copy
      await expect(page.locator('button:has(.i-carbon-checkmark)')).toBeVisible()

      // Verify clipboard contains invite URL
      const clipboardText = await page.evaluate(() => navigator.clipboard.readText())
      expect(clipboardText).toContain('http')
      expect(clipboardText).toContain('#')
    })
  })

  test.describe('Two-user chat', () => {
    test('should allow two users to chat via URL', async ({ browser }) => {
      const context1 = await browser.newContext()
      const context2 = await browser.newContext()

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // User 1: Login and create invite
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Get Started' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        await page1.getByRole('button', { name: 'Create Invite' }).click()

        // Get the invite URL from the readonly input
        const inviteUrl = await page1.locator('input[readonly]').inputValue()

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
        // User 1: Login and create invite
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Get Started' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        await page1.getByRole('button', { name: 'Create Invite' }).click()

        // Get the invite URL from the readonly input
        const inviteUrl = await page1.locator('input[readonly]').inputValue()

        // User 2: Login and join via paste link
        await page2.goto('/')
        await page2.getByRole('button', { name: 'Get Started' }).click()
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
        // User 1: Login and create invite
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Get Started' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        await page1.getByRole('button', { name: 'Create Invite' }).click()

        // Get the invite URL from the readonly input
        const inviteUrl = await page1.locator('input[readonly]').inputValue()

        // User 2: Login and join via paste link
        await page2.goto('/')
        await page2.getByRole('button', { name: 'Get Started' }).click()
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
        await expect(page2.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Before reload' })).toBeVisible()

        // User 1 goes back and reloads
        await page1.getByRole('button', { name: 'Back' }).click()

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
  })
})

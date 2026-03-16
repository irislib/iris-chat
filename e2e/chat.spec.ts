import { test, expect, useTestRelay } from './fixtures'
import type { Page, BrowserContext, Locator } from '@playwright/test'
import { nip19 } from 'nostr-tools'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Helper: reload page, retrying if navigation is aborted by background activity
async function safeReload(page: Page) {
  try {
    await page.reload({ waitUntil: 'domcontentloaded' })
  } catch (e: any) {
    if (e.message?.includes('ERR_ABORTED') || e.message?.includes('frame was detached')) {
      // App was mid-navigation; wait a moment and try again
      await page.waitForTimeout(500)
      await page.reload({ waitUntil: 'domcontentloaded' })
    } else {
      throw e
    }
  }
}

// Helper to get invite URL from CopyButton (has title attribute with full URL)
// Rewrites chat.iris.to URLs to localhost for e2e tests
async function getInviteUrl(page: Page): Promise<string> {
  const copyButton = page.locator('button[title*="#"]').first()
  await expect(copyButton).toBeVisible()
  const url = await copyButton.getAttribute('title')
  if (!url) throw new Error('Could not get invite URL')
  // Rewrite production URL to test server (invite URLs use chat.iris.to on localhost)
  return url.replace('https://chat.iris.to', 'http://localhost:4173')
}

// Helper to setup a user and get their invite URL
async function setupUserWithInvite(page: Page): Promise<string> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Go' }).click()
  await registerDevice(page)
  await page.getByRole('button', { name: 'New Chat' }).click()
  // Invite is auto-created, just get the URL
  return getInviteUrl(page)
}

async function registerDevice(page: Page): Promise<void> {
  const settingsButton = page.getByRole('button', { name: 'Settings' })
  try {
    await settingsButton.waitFor({ state: 'visible', timeout: 5000 })
  } catch {
    return
  }

  await settingsButton.click()
  // Ensure the settings view has rendered before probing for the register button.
  // This avoids spending the full timeout waiting when the device is already registered.
  await page.getByRole('heading', { name: 'Devices' }).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  const registerButton = page.getByRole('button', { name: 'Register this device' })
  const thisDeviceLabel = page.getByText('This device').first()
  try {
    if (!(await registerButton.count())) {
      // If the device state is still initializing, wait until we can tell whether
      // registration is needed (button appears) or already done ("This device" appears).
      await Promise.race([
        registerButton.waitFor({ state: 'visible', timeout: 5000 }).catch(() => null),
        thisDeviceLabel.waitFor({ state: 'visible', timeout: 5000 }).catch(() => null),
      ])
    }
    if (await registerButton.count()) {
      await registerButton.click({ timeout: 5000 })
      await Promise.race([
        registerButton.waitFor({ state: 'hidden', timeout: 20000 }).catch(() => null),
        thisDeviceLabel.waitFor({ state: 'visible', timeout: 20000 }).catch(() => null),
      ])
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    const lowered = message.toLowerCase()
    if (
      !lowered.includes('timeout') &&
      !lowered.includes('not found') &&
      !lowered.includes('detached') &&
      !lowered.includes('not stable')
    ) {
      throw err
    }
    // Button likely absent or disappeared due to auto-registration; continue.
  }
  await page.getByRole('button', { name: 'Back' }).click()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function dispatchFileDrop(target: Locator, filePath: string, mimeType: string): Promise<void> {
  const bytes = Array.from(readFileSync(filePath))
  const fileName = filePath.split('/').pop() || 'attachment'

  await target.evaluate((element, payload) => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array(payload.bytes)], payload.fileName, { type: payload.mimeType }))
    element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  }, { bytes, fileName, mimeType })
}

async function dispatchFilePaste(target: Locator, filePath: string, mimeType: string): Promise<void> {
  const bytes = Array.from(readFileSync(filePath))
  const fileName = filePath.split('/').pop() || 'attachment'

  await target.evaluate((element, payload) => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array(payload.bytes)], payload.fileName, { type: payload.mimeType }))
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: dt,
      configurable: true,
    })
    element.dispatchEvent(pasteEvent)
  }, { bytes, fileName, mimeType })
}

async function openChatFromList(page: Page, message: string): Promise<void> {
  const chatList = page.getByTestId('sidebar-chat-list')
  const listItemName = new RegExp(escapeRegExp(message))

  // Chats may appear under Requests first (message requests). Poll both tabs so we don't
  // waste a full timeout waiting on All when the chat is in Requests.
  const allTab = page.getByTestId('sidebar-tab-all')
  const requestsTab = page.getByTestId('sidebar-tab-requests')
  const deadline = Date.now() + 30_000

  while (Date.now() < deadline) {
    for (const tabButton of [allTab, requestsTab]) {
      await tabButton.click().catch(() => {})
      const listItem = chatList.getByRole('button', { name: listItemName }).first()
      if (await listItem.isVisible().catch(() => false)) {
        await listItem.scrollIntoViewIfNeeded().catch(() => {})
        await listItem.click()
        return
      }
    }
    await page.waitForTimeout(250)
  }

  throw new Error(`Could not find chat list item for message preview: ${message}`)
}

async function joinViaPasteAndSync(inviter: Page, joiner: Page, inviteUrl: string, message: string): Promise<void> {
  await registerDevice(inviter)
  await registerDevice(joiner)
  await joiner.getByPlaceholder('Paste invite link').fill(inviteUrl)
  await expect(joiner.getByPlaceholder('Type a message...')).toBeVisible()
  await joiner.getByPlaceholder('Type a message...').fill(message)
  await joiner.getByRole('button', { name: 'Send' }).click()
  await openChatFromList(inviter, message)
  await expect(inviter.locator('.max-w-\\[85\\%\\]').filter({ hasText: message })).toBeVisible()
}

async function joinViaUrlAndSync(inviter: Page, joiner: Page, inviteUrl: string, message: string): Promise<void> {
  await joiner.goto(inviteUrl)
  await expect(joiner.getByRole('button', { name: 'Join Chat' })).toBeVisible()
  await joiner.getByRole('button', { name: 'Join Chat' }).click()
  await registerDevice(inviter)
  await registerDevice(joiner)
  await expect(joiner.getByPlaceholder('Type a message...')).toBeVisible()
  await joiner.getByPlaceholder('Type a message...').fill(message)
  await joiner.getByRole('button', { name: 'Send' }).click()
  const inviterMessage = inviter.locator('.max-w-\\[85\\%\\]').filter({ hasText: message })
  try {
    await expect(inviterMessage).toBeVisible({ timeout: 15000 })
  } catch {
    await openChatFromList(inviter, message)
    await expect(inviterMessage).toBeVisible()
  }
}

// Helper to create a context configured to use the test relay
async function createContext(browser: import('@playwright/test').Browser, relayUrl: string): Promise<BrowserContext> {
  const context = await browser.newContext()
  await useTestRelay(context, relayUrl)
  return context
}

test.describe('iris chat', () => {
  test('shows a new messages indicator in chat list for unseen incoming messages', async ({ browser, testRelayUrl }) => {
    const context1 = await createContext(browser, testRelayUrl)
    const context2 = await createContext(browser, testRelayUrl)

    const inviter = await context1.newPage()
    const joiner = await context2.newPage()

    try {
      const firstMessage = 'First ping'
      const secondMessage = 'Second ping'

      // Setup: User 1 creates a chat invite.
      const inviteUrl = await setupUserWithInvite(inviter)

      // User 2 joins the chat and sends an initial message (establishes the session).
      await joiner.goto('/')
      await joiner.getByRole('button', { name: 'Go' }).click()
      await joiner.getByRole('button', { name: 'New Chat' }).click()
      await joinViaPasteAndSync(inviter, joiner, inviteUrl, firstMessage)

      // User 1 returns to the chat list (chat is no longer open).
      await inviter.getByRole('button', { name: 'Back' }).click()

      // User 2 sends a second message while User 1 is not in the chat view.
      await joiner.getByPlaceholder('Type a message...').fill(secondMessage)
      await joiner.getByRole('button', { name: 'Send' }).click()

      // Verify unread indicator shows up on the list item.
      await inviter.getByTestId('sidebar-tab-requests').click()
      const listItem = inviter
        .getByTestId('sidebar-chat-list')
        .getByRole('button', { name: new RegExp(escapeRegExp(secondMessage)) })
        .first()
      await expect(listItem).toBeVisible({ timeout: 30000 })

      const unreadIndicator = listItem.getByTestId('unread-indicator')
      await expect(unreadIndicator).toHaveCount(1)
      await expect(unreadIndicator).toHaveText('1')

      // Opening the chat should clear the indicator.
      await listItem.click()
      await expect(unreadIndicator).toHaveCount(0)
    } finally {
      await context1.close()
      await context2.close()
    }
  })

  test.describe('Chat input', () => {
    test('should focus input when opening or switching chat', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const page1 = await context1.newPage()

      try {
        // Create two chats locally by pasting two different npub invites.
        // This is much faster and avoids multi-context sync flakiness, while still
        // exercising the real UI flow for opening and switching chats.
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Go' }).click()
        await expect(page1.getByRole('button', { name: 'New Chat' })).toBeVisible()
        await registerDevice(page1)

        const npub1 = nip19.npubEncode('b'.repeat(64))
        const npub2 = nip19.npubEncode('c'.repeat(64))

        await page1.getByRole('button', { name: 'New Chat' }).click()
        await page1.getByPlaceholder('Paste invite link').fill(npub1)
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page1.getByPlaceholder('Type a message...')).toBeFocused()

        await page1.getByRole('button', { name: 'Back' }).click()

        await page1.getByRole('button', { name: 'New Chat' }).click()
        await page1.getByPlaceholder('Paste invite link').fill(npub2)
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page1.getByPlaceholder('Type a message...')).toBeFocused()

        // Switch back to the first chat from the list
        await page1.getByRole('button', { name: 'Back' }).click()
        const chatButtons = page1.getByTestId('sidebar-chat-list').getByRole('button')
        await expect(chatButtons).toHaveCount(2)
        await chatButtons.first().click()
        await expect(page1.getByPlaceholder('Type a message...')).toBeFocused()
      } finally {
        await context1.close()
      }
    })

    test('should persist own messages across reload', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

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
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'Hello there')
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

        // User 2 sends their own message
        await page2.getByPlaceholder('Type a message...').fill('My own message')
        await page2.getByRole('button', { name: 'Send' }).click()
        await expect(page2.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'My own message' })).toBeVisible()

        // User 2 goes back and reloads
        await page2.getByRole('button', { name: 'Back' }).click()
        await safeReload(page2)

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

    test('should unfocus input on Escape key', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

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
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'Hello')
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

    test('should keep focus in input after sending message', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

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
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'Hello')
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

    test('should persist message drafts per chat when switching', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const page1 = await context1.newPage()

      try {
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Go' }).click()
        await registerDevice(page1)

        const npub1 = nip19.npubEncode('b'.repeat(64))
        const npub2 = nip19.npubEncode('c'.repeat(64))

        // Create chat 1 and type a draft (but do NOT send)
        await page1.getByRole('button', { name: 'New Chat' }).click()
        await page1.getByPlaceholder('Paste invite link').fill(npub1)
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await page1.getByPlaceholder('Type a message...').fill('Draft for chat one')

        // Create chat 2 and type a draft
        await page1.getByRole('button', { name: 'Back' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        await page1.getByPlaceholder('Paste invite link').fill(npub2)
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await page1.getByPlaceholder('Type a message...').fill('Draft for chat two')

        // Switch back to chat 1
        await page1.getByRole('button', { name: 'Back' }).click()
        const chatButtons = page1.getByTestId('sidebar-chat-list').getByRole('button')
        await expect(chatButtons).toHaveCount(2)
        await chatButtons.first().click()
        await expect(page1.getByPlaceholder('Type a message...')).toHaveValue('Draft for chat one')

        // Switch back to chat 2
        await page1.getByRole('button', { name: 'Back' }).click()
        await chatButtons.nth(1).click()
        await expect(page1.getByPlaceholder('Type a message...')).toHaveValue('Draft for chat two')
      } finally {
        await context1.close()
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
      await safeReload(page)

      // Should still be logged in
      await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible()
    })

    test('should switch from an open group to New Chat view', async ({ page }) => {
      const groupName = `nav-group-${Date.now()}`
      const npub = nip19.npubEncode('d'.repeat(64))

      await page.goto('/')
      await page.getByRole('button', { name: 'Go' }).click()
      await registerDevice(page)

      // Create a direct chat so "Create Group" becomes available.
      await page.getByRole('button', { name: 'New Chat' }).click()
      await page.getByPlaceholder('Paste invite link').fill(npub)
      await expect(page.getByPlaceholder('Type a message...')).toBeVisible()
      await page.getByRole('button', { name: 'Back' }).click()

      await expect(page.getByRole('button', { name: 'Create Group' })).toBeVisible()
      await page.getByRole('button', { name: 'Create Group' }).click()
      await expect(page.getByRole('heading', { name: 'Select Members' })).toBeVisible()
      const createGroupView = page.getByTestId('create-group-view')

      // Select the first available contact and create the group.
      await createGroupView.getByTestId('create-group-member').first().click()
      await createGroupView.getByTestId('create-group-next').click()
      await page.getByPlaceholder('Enter group name...').fill(groupName)
      await createGroupView.getByTestId('create-group-submit').click()

      // Open group chat is visible.
      await expect(page.getByText(groupName).first()).toBeVisible()

      // Regression: this should leave group chat and show New Chat main view.
      await page.getByRole('button', { name: 'New Chat' }).click()
      await expect(page.getByRole('heading', { name: 'New Chat' })).toBeVisible()
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
    test('should delete chat from header menu', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

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
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'Hello')
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

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
    test('should delete message locally via context menu', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

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
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'First message')
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

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

    test('should copy message via context menu', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

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
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'Copy this text')
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

        // User 1 hovers over message to reveal menu
        const messageBubble = page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Copy this text' })
        await messageBubble.hover()

        // Click the menu button
        await page1.locator('button[aria-label="Message menu"]').first().click()

        // Click copy option (use exact match to avoid sidebar copy button)
        await page1.getByRole('button', { name: 'Copy', exact: true }).click()

        // Verify clipboard contains the message text (clipboard writes can be async)
        await expect.poll(
          () => page1.evaluate(() => navigator.clipboard.readText()),
          { timeout: 5000 }
        ).toBe('Copy this text')
      } finally {
        await context1.close()
        await context2.close()
      }
    })
  })

  test.describe('Media modal', () => {
    test('should open image in modal overlay when clicked', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

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
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'Hello')
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

    test('should open markdown image URL in modal overlay when clicked', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

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
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'Hello')
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

        const markdownImage = '![markdown image](https://example.com/test.jpg)'
        await page2.getByPlaceholder('Type a message...').fill(markdownImage)
        await page2.getByRole('button', { name: 'Send' }).click()

        const markdownImageEl = page1.locator('.message-content img[alt="markdown image"]').first()
        await expect(markdownImageEl).toHaveCount(1)

        await expect(page1.locator('[data-testid="media-modal"]')).not.toBeVisible()
        await page1.evaluate(() => {
          const el = document.querySelector('.message-content img[alt="markdown image"]') as HTMLImageElement | null
          if (!el) throw new Error('Markdown image not found')
          el.click()
        })

        await expect(page1.locator('[data-testid="media-modal"]')).toBeVisible()
      } finally {
        await context1.close()
        await context2.close()
      }
    })

    test('should open video attachment in modal overlay when clicked', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

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
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'Hello')
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

        // User 2 sends a message with a fake video nhash
        const fakeNhash = 'nhash1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr5thfd'
        await page2.getByPlaceholder('Type a message...').fill(`${fakeNhash}/clip.mp4`)
        await page2.getByRole('button', { name: 'Send' }).click()

        // Wait for file attachment to appear and open video modal
        await expect(page1.locator('.file-attachment')).toBeVisible()
        await page1.locator('.file-attachment button').first().click()

        // Modal overlay should appear with filename
        await expect(page1.locator('[data-testid="media-modal"]')).toBeVisible()
        await expect(page1.locator('[data-testid="media-modal"]')).toContainText('clip.mp4')
      } finally {
        await context1.close()
        await context2.close()
      }
    })

    test('should close modal when clicking backdrop', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

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
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'Hello')
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

    test('should close modal when pressing Escape', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

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
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'Hello')
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

    test('should have close button in modal', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

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
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'Hello')
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
    test('should show attachment button in chat', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

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
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'Hello')
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

        // Attachment button should be visible
        await expect(page1.getByRole('button', { name: 'Attach file' })).toBeVisible()
      } finally {
        await context1.close()
        await context2.close()
      }
    })

    test('should attach a file when dropped on chat input', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Go' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        const inviteUrl = await getInviteUrl(page1)

        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'Hello')
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

        const fixturePath = fileURLToPath(new URL('./fixtures/test-blob.jpeg', import.meta.url))
        const input = page1.getByPlaceholder('Type a message...')
        await input.focus()
        await dispatchFileDrop(input, fixturePath, 'image/jpeg')

        await expect(page1.getByRole('button', { name: 'Remove attachment' })).toBeVisible()
        await expect(page1.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 30000 })

        await page1.getByRole('button', { name: 'Send' }).click()
        await expect(page2.locator('.file-attachment')).toBeVisible({ timeout: 30000 })
      } finally {
        await context1.close()
        await context2.close()
      }
    })

    test('should attach a file when pasted into chat input', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Go' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        const inviteUrl = await getInviteUrl(page1)

        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'Hello')
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

        const fixturePath = fileURLToPath(new URL('./fixtures/test-blob.jpeg', import.meta.url))
        const input = page1.getByPlaceholder('Type a message...')
        await input.focus()
        await dispatchFilePaste(input, fixturePath, 'image/jpeg')

        await expect(page1.getByRole('button', { name: 'Remove attachment' })).toBeVisible()
        await expect(page1.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 30000 })

        await page1.getByRole('button', { name: 'Send' }).click()
        await expect(page2.locator('.file-attachment')).toBeVisible({ timeout: 30000 })
      } finally {
        await context1.close()
        await context2.close()
      }
    })

    test('should display file attachment when nhash link is in message', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

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
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'Hello')
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

    test('should render text and image attachment in the same bubble', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        await page1.goto('/')
        await page1.getByRole('button', { name: 'Go' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        const inviteUrl = await getInviteUrl(page1)

        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'Hello')
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

        const fakeNhash = 'nhash1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr5thfd'
        const caption = 'Caption before image'
        await page2.getByPlaceholder('Type a message...').fill(`${caption} ${fakeNhash}/test-image.jpg`)
        await page2.getByRole('button', { name: 'Send' }).click()

        const textBubble = page1.getByTestId('message-bubble-body').filter({ hasText: caption }).first()
        await expect(textBubble).toBeVisible()
        await expect(textBubble.locator('.file-attachment')).toHaveCount(1)
      } finally {
        await context1.close()
        await context2.close()
      }
    })
  })

  test.describe('Reactions', () => {
    test('should persist reactions across reload', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

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
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'React to this!')
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

        // User 1 adds a reaction
        const messageBubble = page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'React to this!' })
        await messageBubble.hover()
        await page1.locator('button[aria-label="Add reaction"]').click()
        await page1.getByRole('button', { name: '❤️' }).click()

        // Reaction should appear
        await expect(page1.locator('.reaction').filter({ hasText: '❤️' })).toBeVisible()

        // User 1 goes back and reloads
        await page1.getByRole('button', { name: 'Back' }).click()
        await safeReload(page1)

        // Open the chat again
        await openChatFromList(page1, 'React to this!')

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

    test('should sync reaction to other user', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

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
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'React to this!')
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

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

    test('should add reaction to message on click', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

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
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'React to this!')
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

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

    test('should allow only one reaction per user (latest wins)', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

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
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'React to this!')
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

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
    test('should navigate to profile page when clicking avatar in chat header', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

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
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'Hi!')
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

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

    test('should open existing chat from profile page', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

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
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'Test')
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

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

    test('should show known app keys on another user profile', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        await page1.goto('/')
        await page1.getByPlaceholder('Name').fill('Alice')
        await page1.getByRole('button', { name: 'Go' }).click()
        await page1.getByRole('button', { name: 'New Chat' }).click()
        const inviteUrl = await getInviteUrl(page1)

        await page2.goto('/')
        await page2.getByPlaceholder('Name').fill('Bob')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'AppKeys check')

        const profileButton = page1.locator('header button').filter({ hasText: 'Bob' }).first()
        await expect(profileButton).toBeEnabled()
        await profileButton.click()

        const disclosure = page1.getByTestId('profile-appkeys-disclosure')
        await expect(disclosure).toBeVisible()
        await expect(disclosure).toContainText('Known App Keys')
        await expect(disclosure).toContainText('device key published')

        await disclosure.locator('summary').click()

        const appKeyButton = disclosure.locator('button[title]').first()
        await expect(appKeyButton).toBeVisible()
        await expect(appKeyButton).toHaveAttribute('title', /^npub1/)
      } finally {
        await context1.close()
        await context2.close()
      }
    })
  })

  test.describe('Settings page', () => {
    test('should open own profile picture in media modal', async ({ page }) => {
      await page.goto('/')
      await page.getByRole('button', { name: 'Go' }).click()
      await page.getByRole('button', { name: 'Settings' }).click()
      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

      await page.getByRole('button', { name: 'View profile picture' }).click()
      await expect(page.locator('[data-testid="media-modal"]')).toBeVisible()
    })
  })

  test.describe('Day separator', () => {
    test('should show "Today" day separator above messages', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

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
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'Hello!')
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

        // "Today" separator should be visible above the message
        await expect(page1.locator('.day-separator').filter({ hasText: 'Today' })).toBeVisible()
        await expect(page2.locator('.day-separator').filter({ hasText: 'Today' })).toBeVisible()
      } finally {
        await context1.close()
        await context2.close()
      }
    })

    test('should show only one day separator for consecutive same-day messages', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

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
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'First')
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()

        // Send multiple messages
        await page2.getByPlaceholder('Type a message...').fill('Second')
        await page2.getByRole('button', { name: 'Send' }).click()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Second' })).toBeVisible()

        await page1.getByPlaceholder('Type a message...').fill('Third')
        await page1.getByRole('button', { name: 'Send' }).click()
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Third' })).toBeVisible()

        // Should have exactly one "Today" separator
        await expect(page1.locator('.day-separator')).toHaveCount(1)
      } finally {
        await context1.close()
        await context2.close()
      }
    })
  })

  test.describe('Two-user chat', () => {
    test('should allow two users to chat via URL', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // User 1: Login and create invite (auto-created)
        const inviteUrl = await setupUserWithInvite(page1)

        // User 2: Navigate to invite URL first (will need to login) and join
        await joinViaUrlAndSync(page1, page2, inviteUrl, 'Hello from User 2!')
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

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

    test('should allow two users to chat via paste link', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // User 1: Login and create invite (auto-created)
        const inviteUrl = await setupUserWithInvite(page1)

        // User 2: Login and join via paste link
        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()

        // Paste the link in the Join Chat input and join
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'Hello via paste!')
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

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

    test('should persist chat session across page reload', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

      const page1 = await context1.newPage()
      const page2 = await context2.newPage()

      try {
        // User 1: Login and create invite (auto-created)
        const inviteUrl = await setupUserWithInvite(page1)

        // User 2: Login and join via paste link
        await page2.goto('/')
        await page2.getByRole('button', { name: 'Go' }).click()
        await page2.getByRole('button', { name: 'New Chat' }).click()
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'Hello!')
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

        // User 1 sends message before reload
        await page1.getByPlaceholder('Type a message...').fill('Before reload')
        await page1.getByRole('button', { name: 'Send' }).click()
        // Wait for User 1 to see their own message (ensures UI updated)
        await expect(page1.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Before reload' })).toBeVisible()
        await expect(page2.locator('.max-w-\\[85\\%\\]').filter({ hasText: 'Before reload' })).toBeVisible()

        // User 1 goes back
        await page1.getByRole('button', { name: 'Back' }).click()
        await page1.getByTestId('sidebar-tab-all').click()
        // Verify sidebar shows the message preview before reload
        await expect(page1.getByText('Before reload')).toBeVisible()
        // Small delay to ensure IndexedDB async save completes
        await page1.waitForTimeout(200)
        // Reload page 1
        await safeReload(page1)

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

    test('should display each others names in chat', async ({ browser, testRelayUrl }) => {
      const context1 = await createContext(browser, testRelayUrl)
      const context2 = await createContext(browser, testRelayUrl)

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
        await joinViaPasteAndSync(page1, page2, inviteUrl, 'Hi!')
        await expect(page2.getByPlaceholder('Type a message...')).toBeVisible()
        await expect(page1.getByPlaceholder('Type a message...')).toBeVisible()

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

import { test, expect } from './fixtures'

test.describe('Notifications', () => {
  test.describe('Settings Page', () => {
    test('should show Settings in avatar dropdown', async ({ page }) => {
      await page.goto('/')
      await page.getByRole('button', { name: 'Go' }).click()

      // Click on avatar to go to settings
      await page.getByRole('button', { name: 'Settings' }).click()

      // Should see Settings header
      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
    })

    test('should navigate to Settings page', async ({ page }) => {
      await page.goto('/')
      await page.getByRole('button', { name: 'Go' }).click()

      // Click on avatar to go to Settings
      await page.getByRole('button', { name: 'Settings' }).click()

      // Should see Settings header
      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

      // Should see notification section
      await expect(page.getByText('Notifications')).toBeVisible()

      // Should see status indicators
      await expect(page.getByText('Notification API')).toBeVisible()
      await expect(page.getByText('Permission')).toBeVisible()
      await expect(page.getByText('Service Worker')).toBeVisible()
      await expect(page.getByText('Push Subscription')).toBeVisible()
    })

    test('should navigate back from Settings', async ({ page }) => {
      await page.goto('/')
      await page.getByRole('button', { name: 'Go' }).click()

      // Navigate to Settings
      await page.getByRole('button', { name: 'Settings' }).click()

      // Click back button
      await page.getByRole('button', { name: 'Back' }).click()

      // Should be back at chat list (no Settings header)
      await expect(page.getByRole('heading', { name: 'Settings' })).not.toBeVisible()
      await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible()
    })

    test('should show status indicators', async ({ page }) => {
      await page.goto('/')
      await page.getByRole('button', { name: 'Go' }).click()

      // Navigate to Settings
      await page.getByRole('button', { name: 'Settings' }).click()

      // Notification API should show as Available (browsers support it)
      await expect(page.getByText('Available').first()).toBeVisible()
    })

    test('should toggle advanced section', async ({ page }) => {
      await page.goto('/')
      await page.getByRole('button', { name: 'Go' }).click()

      // Navigate to Settings
      await page.getByRole('button', { name: 'Settings' }).click()

      // Advanced section should be collapsed
      await expect(page.getByText('Notification Server URL')).not.toBeVisible()

      // Click to expand
      await page.getByRole('button', { name: 'Advanced' }).click()

      // Should see server URL input
      await expect(page.getByText('Notification Server URL')).toBeVisible()
      await expect(page.locator('#server-url')).toBeVisible()
    })

    test('should persist notification settings in localStorage', async ({ page }) => {
      await page.goto('/')
      await page.getByRole('button', { name: 'Go' }).click()

      // Navigate to Settings
      await page.getByRole('button', { name: 'Settings' }).click()

      // Expand advanced section
      await page.getByRole('button', { name: 'Advanced' }).click()

      // Change server URL
      await page.locator('#server-url').fill('https://custom.server.com')
      await page.getByRole('button', { name: 'Save' }).click()

      // Reload page - settings page should still be shown (URL has #settings)
      await page.reload()

      // Settings page should already be visible after reload
      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()

      // Expand advanced section again
      await page.getByRole('button', { name: 'Advanced' }).click()

      // Should have the saved URL
      await expect(page.locator('#server-url')).toHaveValue('https://custom.server.com')
    })

    test('should show permission denied status in headless browser', async ({ page }) => {
      // In headless Chromium, notification permission is 'denied' by default
      await page.goto('/')
      await page.getByRole('button', { name: 'Go' }).click()

      // Navigate to Settings
      await page.getByRole('button', { name: 'Settings' }).click()

      // Permission should show as Denied in headless browser
      await expect(page.getByText('Denied')).toBeVisible()
    })
  })

  test.describe('Notification Prompt', () => {
    test('should not show notification prompt when permission is denied', async ({ page }) => {
      // In headless Chromium, notification permission is 'denied' by default
      // The prompt only shows when permission is 'default'
      await page.goto('/')
      await page.getByRole('button', { name: 'Go' }).click()

      // Prompt should NOT be visible when permission is denied
      await expect(page.getByText('Get notified when you receive new messages')).not.toBeVisible()
    })

    test('should persist declined state in localStorage when declined via store', async ({ page }) => {
      await page.goto('/')
      await page.getByRole('button', { name: 'Go' }).click()

      // Manually set declined state via localStorage (simulating decline action)
      await page.evaluate(() => {
        localStorage.setItem('iris-chat-notifications', JSON.stringify({
          enabled: false,
          serverUrl: 'https://notifications.iris.to',
          declined: true
        }))
      })

      // Reload page
      await page.reload()

      // Verify localStorage was persisted
      const settings = await page.evaluate(() => localStorage.getItem('iris-chat-notifications'))
      expect(settings).toBeTruthy()
      const parsed = JSON.parse(settings!)
      expect(parsed.declined).toBe(true)
    })
  })

  test.describe('Test Notification', () => {
    test('test notification button should be disabled without permission', async ({ page }) => {
      await page.goto('/')
      await page.getByRole('button', { name: 'Go' }).click()

      // Navigate to Settings
      await page.getByRole('button', { name: 'Settings' }).click()

      // Test notification button should be disabled (permission is denied in headless)
      const testButton = page.getByRole('button', { name: 'Send Test Notification' })
      await expect(testButton).toBeDisabled()
    })
  })

  test.describe('Settings Toggle', () => {
    test('should show toggle in off state by default', async ({ page }) => {
      await page.goto('/')
      await page.getByRole('button', { name: 'Go' }).click()

      // Navigate to Settings
      await page.getByRole('button', { name: 'Settings' }).click()

      // Toggle should be in off state (aria-checked="false")
      const toggle = page.getByRole('switch', { name: 'Toggle DM notifications' })
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
    })
  })

  test.describe('Service Worker', () => {
    test('should show service worker as running', async ({ page }) => {
      await page.goto('/')
      await page.getByRole('button', { name: 'Go' }).click()

      // Navigate to Settings
      await page.getByRole('button', { name: 'Settings' }).click()

      // Service Worker should show as Running
      await expect(page.getByText('Running')).toBeVisible()
    })
  })
})

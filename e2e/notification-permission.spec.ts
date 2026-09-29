import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

// Exercise the built app in Chromium and WebKit. Permission responses are
// simulated: Playwright cannot approve the real iOS Home Screen system dialog.
async function openSettings(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Go', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Notifications', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('pwa-install-dismissed', String(Date.now()))
  })
})

for (const device of ['iPhone', 'iPad desktop mode']) {
  test(`${device} Safari explains Home Screen requirement without an unusable Allow button`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript((device) => {
      Object.defineProperty(navigator, 'userAgent', { value: device === 'iPhone' ? 'iPhone Safari' : 'Macintosh Safari' })
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5 })
      Reflect.deleteProperty(window, 'Notification')
      Reflect.deleteProperty(window, 'PushManager')
    }, device)
    await openSettings(page)
    await expect(page.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0)
    await expect(page.getByText('To get notifications, choose Share → Add to Home Screen, then open Iris from your Home Screen.')).toBeVisible()
    await expect(page.getByRole('switch', { name: 'Toggle DM notifications' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Send Test Notification' })).toBeDisabled()
    expect(errors).toEqual([])
    if (device === 'iPhone') {
      await page.getByRole('heading', { name: 'Notifications', exact: true }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: test.info().outputPath('ios-notification-guidance.png') })
    }
  })
}

test('unsupported browsers show an explanation without an Allow button', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Desktop Browser' })
    Reflect.deleteProperty(window, 'Notification')
  })
  await openSettings(page)
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0)
  await expect(page.getByText('This browser does not support push notifications.')).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Toggle DM notifications' })).toBeDisabled()
})

async function simulatePermission(page: Page, outcome: NotificationPermission | 'error', pushAvailable = true) {
  await page.addInitScript(({ outcome, pushAvailable }) => {
    Object.defineProperty(navigator, 'userAgent', { value: 'iPhone Safari' })
    Object.defineProperty(navigator, 'standalone', { value: true })
    let permission: NotificationPermission = 'default'
    Object.defineProperty(window, 'Notification', { configurable: true, value: {
      get permission() { return permission },
      requestPermission() {
        // A native Safari request must run directly from a user gesture.
        if (!navigator.userActivation.isActive) throw new Error('Missing user activation')
        if (outcome === 'error') return Promise.reject(new Error('Permission request failed'))
        permission = outcome
        return Promise.resolve(outcome)
      },
    } })
    if (!pushAvailable) {
      Reflect.deleteProperty(window, 'PushManager')
    } else if (!('PushManager' in window)) {
      Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} })
    }
  }, { outcome, pushAvailable })
}

for (const outcome of ['default', 'denied', 'error'] as const) {
  test(`Allow gives visible feedback when permission is ${outcome}`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await simulatePermission(page, outcome)
    await openSettings(page)
    await page.getByRole('button', { name: 'Allow', exact: true }).click()
    const message = outcome === 'default'
      ? 'Notifications were not allowed. Please try again.'
      : outcome === 'denied'
        ? 'Notifications are blocked. Enable them in your browser or device notification settings.'
        : 'Could not request notification permission. Please try again.'
    await expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible()
    await expect(page.getByRole('switch', { name: 'Toggle DM notifications' })).toHaveAttribute('aria-checked', 'false')
    expect(errors).toEqual([])
  })
}

test('Home Screen Allow requests permission from the tap and reports granted', async ({ page }) => {
  await simulatePermission(page, 'granted')
  // Do not let an unrelated auto-subscription make a real network request.
  await page.route('https://notifications.iris.to/**', route => route.fulfill({ status: 503, body: '{}' }))
  await openSettings(page)
  await expect(page.getByText(/choose Share → Add to Home Screen/)).toHaveCount(0)
  await page.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(page.getByText('Granted', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0)
})

test('a browser with notifications but no Push API cannot enable push', async ({ page }) => {
  await simulatePermission(page, 'granted', false)
  await openSettings(page)
  await expect(page.getByText('This browser does not support push notifications.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0)
  await expect(page.getByRole('switch', { name: 'Toggle DM notifications' })).toBeDisabled()
})

async function simulatePushSubscription(page: Page) {
  await page.addInitScript(() => {
    let subscription: object | null = null
    Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', { get() {
      return {
        getSubscription: async () => subscription,
        subscribe: async () => {
          subscription = {
            endpoint: 'https://push.example.test/subscription',
            options: {},
            getKey: () => new Uint8Array([1, 2, 3]).buffer,
          }
          return subscription
        },
      }
    } })
  })
}

test('Enable keeps subscription failures visible after permission is granted', async ({ page }) => {
  await simulatePermission(page, 'granted')
  await simulatePushSubscription(page)
  await page.route('https://notifications.iris.to/**', route => route.fulfill({
    json: { error: 'Notification server unavailable' },
  }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Go', exact: true }).click()
  await page.getByRole('button', { name: 'Enable', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Notification server unavailable')
  await expect(page.getByRole('button', { name: 'Enable', exact: true })).toBeEnabled()
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('iris-chat-notifications') || '{}').enabled === true)).toBe(false)
})

test('Home Screen toggle enables notifications after permission and subscription succeed', async ({ page }) => {
  await simulatePermission(page, 'granted')
  await simulatePushSubscription(page)
  await page.route('https://notifications.iris.to/**', route => route.fulfill({
    json: route.request().url().endsWith('/info') ? { vapid_public_key: 'test-key' } : {},
  }))
  await openSettings(page)
  await page.getByRole('switch', { name: 'Toggle DM notifications' }).click()
  await expect(page.getByRole('status')).toHaveText('Notifications enabled')
  await expect(page.getByRole('switch', { name: 'Toggle DM notifications' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText('Subscribed', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Enable', exact: true })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('iris-chat-notifications') || '{}').enabled)).toBe(true)
})

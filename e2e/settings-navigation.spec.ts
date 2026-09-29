import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { nip19 } from 'nostr-tools'

const sections = [
  ['Profile', 'profile'],
  ['Appearance', 'appearance'],
  ['Privacy', 'privacy'],
  ['Notifications', 'notifications'],
  ['Calls', 'calls'],
  ['Devices', 'devices'],
  ['Message servers', 'network'],
  ['About', 'about'],
] as const
const menu = (page: Page) => page.getByRole('navigation', { name: 'Settings sections' })
const back = (page: Page) => page.getByRole('button', { name: 'Back', exact: true })

async function openSettings(page: Page) {
  await page.goto('/')
  await page.getByLabel('Your name (optional)').fill('Taylor')
  await page.getByRole('button', { name: 'Go', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page).toHaveURL(/#settings$/)
  await expect(menu(page)).toBeVisible()
}

async function section(page: Page, name: string) {
  if (!await menu(page).isVisible()) await back(page).click()
  await menu(page).getByRole('link', { name, exact: true }).click()
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

for (const [width, height] of [[320, 568], [390, 844], [1024, 768], [1440, 900]] as const) {
  test(`settings menu and detail fit ${width}px with usable back navigation`, async ({ page }, info) => {
    const split = width === 1440
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ colorScheme: 'light' })
    await openSettings(page)
    await expect(page.getByRole('heading', { name: 'Settings', exact: true, level: 1 })).toBeVisible()
    for (const [name, path] of sections) {
      const link = menu(page).getByRole('link', { name, exact: true })
      await expect(link).toHaveAttribute('href', `#settings/${path}`)
      await link.scrollIntoViewIfNeeded()
      await link.click({ trial: true })
    }
    if (split) await expect(page.getByLabel('Display name', { exact: true })).toBeVisible()
    else await expect(page.getByLabel('Display name', { exact: true })).toBeHidden()
    await menu(page).getByRole('link', { name: 'Profile', exact: true }).scrollIntoViewIfNeeded()
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `work/settings-navigation/${info.project.name}-${width}-menu.png` })
    await section(page, 'Privacy')
    await expect(page).toHaveURL(/#settings\/privacy$/)
    await expect(page.getByRole('heading', { name: split ? 'Settings' : 'Privacy', exact: true, level: 1 })).toBeVisible()
    await expect(page.getByRole('switch', { name: 'Toggle read receipts', exact: true })).toBeVisible()
    if (split) {
      await expect(menu(page)).toBeVisible()
      await expect(menu(page).getByRole('link', { name: 'Privacy', exact: true })).toHaveAttribute('aria-current', 'page')
    }
    else await expect(menu(page)).toBeHidden()
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `work/settings-navigation/${info.project.name}-${width}-privacy.png` })
    await back(page).click()
    await expect(page).toHaveURL(/#settings$/)
    await expect(menu(page)).toBeVisible()
    await back(page).click()
    await expect(page.getByRole('button', { name: 'New Chat', exact: true })).toBeVisible()
    await expect(menu(page)).toBeHidden()
    expect(new URL(page.url()).hash).toBe('')
  })
}

test('settings subpages survive browser history, refresh and direct entry', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openSettings(page)
  await section(page, 'Calls')
  await expect(page.getByRole('switch', { name: 'Voice calls', exact: true })).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/#settings$/)
  await expect(menu(page)).toBeVisible()
  await page.goForward()
  await expect(page).toHaveURL(/#settings\/calls$/)
  await expect(page.getByRole('heading', { name: 'Calls', level: 1, exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('switch', { name: 'Voice calls', exact: true })).toBeVisible()
  await expect(menu(page)).toBeHidden()
  await page.goto('/#settings/notifications')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Notifications', level: 1, exact: true })).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Toggle DM notifications', exact: true })).toBeVisible()
  await back(page).click()
  await expect(page).toHaveURL(/#settings$/)
  await page.goto('/#settings/unknown')
  await page.reload()
  await expect(menu(page)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Settings', level: 1, exact: true })).toBeVisible()
  await back(page).click()
  await expect(page.getByRole('button', { name: 'New Chat', exact: true })).toBeVisible()
  expect(new URL(page.url()).hash).toBe('')
})

test('theme, call and privacy preferences persist across settings pages', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openSettings(page)
  await section(page, 'Appearance')
  await page.getByLabel('Theme', { exact: true }).selectOption('dark')
  await section(page, 'Calls')
  const calls = page.getByRole('switch', { name: 'Voice calls', exact: true })
  const wasEnabled = await calls.getAttribute('aria-checked')
  await calls.click()
  const expectedCalls = wasEnabled === 'true' ? 'false' : 'true'
  await expect(calls).toHaveAttribute('aria-checked', expectedCalls)
  await section(page, 'Privacy')
  const receipts = page.getByRole('switch', { name: 'Toggle read receipts', exact: true })
  const receiptsEnabled = await receipts.getAttribute('aria-checked')
  await receipts.click()
  const expectedReceipts = receiptsEnabled === 'true' ? 'false' : 'true'
  await expect(receipts).toHaveAttribute('aria-checked', expectedReceipts)
  await section(page, 'Calls')
  await expect(calls).toHaveAttribute('aria-checked', expectedCalls)
  await page.reload()
  await expect(calls).toHaveAttribute('aria-checked', expectedCalls)
  await section(page, 'Privacy')
  await expect(receipts).toHaveAttribute('aria-checked', expectedReceipts)
  await section(page, 'Appearance')
  await expect(page.getByLabel('Theme', { exact: true })).toHaveValue('dark')
  await noHorizontalOverflow(page)
  await page.screenshot({ path: `work/settings-navigation/${info.project.name}-1440-appearance-dark.png` })
})

test('leaving Profile hides the revealed secret when returning', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openSettings(page)
  await section(page, 'Profile')
  const secret = page.locator('code').filter({ hasText: /^nsec1/ })
  await expect(secret).toBeHidden()
  await page.getByRole('button', { name: 'Show', exact: true }).click()
  await expect(secret).toBeVisible()
  await back(page).click()
  await section(page, 'About')
  await expect(page.getByRole('link', { name: 'Get the native app', exact: true })).toHaveAttribute('href', 'https://irischat.org/#downloads')
  await section(page, 'Profile')
  await expect(secret).toBeHidden()
  await expect(page.getByRole('button', { name: 'Show', exact: true })).toBeVisible()
})

test('browser Back closes profile and device dialogs when leaving their page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openSettings(page)
  await section(page, 'Profile')
  await page.getByRole('button', { name: 'View profile picture', exact: true }).click()
  await expect(page.getByTestId('media-modal')).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/#settings$/)
  await expect(page.getByTestId('media-modal')).toBeHidden()
  await section(page, 'Devices')
  await page.getByRole('button', { name: 'Link another device', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Link another device', exact: true })).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/#settings$/)
  await expect(page.getByRole('heading', { name: 'Link another device', exact: true })).toBeHidden()
  await section(page, 'Devices')
  await expect(page.getByPlaceholder('Paste link code')).toBeHidden()
})

test('returning from Settings preserves the open group through refresh', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openSettings(page)
  await section(page, 'Devices')
  const register = page.getByRole('button', { name: 'Register this device', exact: true })
  await expect(async () => {
    if (await register.isVisible()) await register.click()
    await expect(page.getByText('This device', { exact: true }).first()).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 30000 })
  await back(page).click()
  await expect(page).toHaveURL(/#settings$/)
  await back(page).click()

  // Create a contact and group using the same controls available to users.
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await page.getByPlaceholder('Paste invite link').fill(nip19.npubEncode('d'.repeat(64)))
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible()
  await back(page).click()
  await page.getByRole('button', { name: 'Create Group', exact: true }).click()
  const createGroup = page.getByTestId('create-group-view')
  await createGroup.getByTestId('create-group-member').first().click()
  await createGroup.getByTestId('create-group-next').click()
  await page.getByPlaceholder('Enter group name...').fill('Weekend plans')
  await createGroup.getByTestId('create-group-submit').click()
  await expect(page).toHaveURL(/#group-/)
  const groupUrl = page.url()
  const groupHeader = page.locator('header').getByRole('button', { name: /Weekend plans/ })
  await expect(groupHeader).toBeVisible()

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await section(page, 'Privacy')
  await expect(page).toHaveURL(/#settings\/privacy$/)
  // The first Back traverses history, restoring the menu without losing the group.
  await back(page).click()
  await expect(page).toHaveURL(/#settings$/)
  await back(page).click()
  await expect(page).toHaveURL(groupUrl)
  await expect(groupHeader).toBeVisible()
  await page.reload()
  await expect(page).toHaveURL(groupUrl)
  await expect(groupHeader).toBeVisible()
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible()
})

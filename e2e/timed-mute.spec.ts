import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { nip19 } from 'nostr-tools'

async function savedMutes(page: Page) {
  return page.evaluate(() => new Promise<Record<string, number>>((resolve, reject) => {
    const opening = indexedDB.open('iris-chat')
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result
      const request = db.transaction('sessionManager').objectStore('sessionManager').getAll()
      request.onsuccess = () => { db.close(); resolve(request.result.find(record => record.key.startsWith('chat-mutes:'))?.value ?? {}) }
      request.onerror = () => { db.close(); reject(request.error) }
    }
  }))
}

for (const group of [false, true]) test(`${group ? 'group' : 'direct'} chat can mute for a duration, restore, unmute, and choose always`, async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Go', exact: true }).click()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await page.getByPlaceholder('Paste invite link').fill(nip19.npubEncode('c'.repeat(64)))
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible()
  if (group) {
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    await page.getByRole('button', { name: 'Create Group', exact: true }).click()
    const create = page.getByTestId('create-group-view')
    await create.getByTestId('create-group-member').first().click()
    await create.getByTestId('create-group-next').click()
    await page.getByPlaceholder('Enter group name...').fill('Weekend plans')
    await create.getByTestId('create-group-submit').click()
    await expect(page).toHaveURL(/#group-/)
  }
  const openOptions = async (muted: boolean) => {
    await page.getByRole('button', { name: 'Chat menu', exact: true }).click()
    await page.getByRole('button', { name: muted ? 'Muted notifications' : 'Mute notifications', exact: true }).click()
    return page.getByRole('dialog', { name: 'Mute notifications', exact: true })
  }
  let dialog = await openOptions(false)
  await expect(dialog.getByRole('button', { name: '1 week', exact: true })).toBeVisible()
  await page.screenshot({ path: `work/timed-mute-web-${group ? 'group' : 'direct'}.png` })
  await dialog.getByRole('button', { name: '1 hour', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect.poll(async () => Object.values(await savedMutes(page)).length).toBe(1)
  const before = await savedMutes(page)
  expect(Object.values(before)[0]).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3500)
  await page.reload()
  if (!group) await page.getByRole('button', { name: /No messages yet/ }).click()
  await expect(page.getByRole('button', { name: 'Chat menu', exact: true })).toBeVisible()
  dialog = await openOptions(true)
  expect(await savedMutes(page)).toEqual(before)
  await dialog.getByRole('button', { name: 'Unmute', exact: true }).click()
  await expect.poll(() => savedMutes(page)).toEqual({})
  dialog = await openOptions(false)
  await dialog.getByRole('button', { name: 'Always', exact: true }).click()
  await expect.poll(async () => Object.values(await savedMutes(page))).toEqual([0])
})

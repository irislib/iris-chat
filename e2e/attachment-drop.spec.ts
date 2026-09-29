import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { nip19 } from 'nostr-tools'

async function openChat(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Go', exact: true }).click()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await page.getByPlaceholder('Paste invite link').fill(nip19.npubEncode('c'.repeat(64)))
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible()
}

async function messages(page: Page) {
  return page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const opening = indexedDB.open('iris-chat')
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result
      const request = db.transaction('messages').objectStore('messages').getAll()
      request.onsuccess = () => { db.close(); resolve(request.result.filter(item => item.isMine).map(item => item.content)) }
      request.onerror = () => { db.close(); reject(request.error) }
    }
  }))
}

async function uploads(page: Page) {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let count = 0
  await page.route(/https:\/\/(cdn|upload|hashtree)\.iris\.to\//, async route => {
    if (route.request().method() !== 'PUT' || !route.request().url().endsWith('/upload')) {
      await route.fulfill({ status: 404 }); return
    }
    count++
    await held
    await route.fulfill({ status: 201, json: { sha256: route.request().headers()['x-sha-256'] } })
  })
  return { release, count: () => count }
}

async function drop(page: Page, names: string[], hover = false) {
  const data = await page.evaluateHandle(names => {
    const transfer = new DataTransfer()
    for (const name of names) transfer.items.add(new File([`Content of ${name}`], name, { type: 'text/plain' }))
    return transfer
  }, names)
  const header = page.getByTestId('chat-file-drop-area').locator('header')
  await header.dispatchEvent('dragover', { dataTransfer: data })
  if (!hover) { await header.dispatchEvent('drop', { dataTransfer: data }); await data.dispose() }
  return data
}

for (const group of [false, true]) test(`whole ${group ? 'group' : 'direct'} chat stages every file and caption until Send`, async ({ page }, testInfo) => {
  const upload = await uploads(page)
  await openChat(page)
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
  const input = page.getByPlaceholder('Type a message...')
  await input.fill('Photos and notes for Saturday')
  const data = await drop(page, ['First.txt', 'Second.pdf'], true)
  await expect(page.getByTestId('file-drop-highlight')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('drag-highlight.png'), fullPage: true })
  await page.getByTestId('chat-file-drop-area').locator('header').dispatchEvent('drop', { dataTransfer: data })
  await data.dispose()
  await expect(page.getByTestId('file-drop-highlight')).toHaveCount(0)
  await expect(page.getByTestId('attachment-preview')).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await input.press('Enter')
  expect(await messages(page)).toEqual([])
  await expect(input).toHaveValue('Photos and notes for Saturday')
  await expect.poll(upload.count).toBeGreaterThan(0)
  upload.release()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  expect(await messages(page)).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('staged-files-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: testInfo.outputPath('staged-files-mobile.png'), fullPage: true })
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('attachment-preview')).toHaveCount(0)
  await expect(input).toHaveValue('')
  await expect.poll(() => messages(page)).toEqual([expect.stringMatching(/^Photos and notes for Saturday\n.*First\.txt.*\n.*Second\.pdf/)])
})

test('late upload cannot reappear after removal or a chat switch', async ({ page }) => {
  const upload = await uploads(page)
  await openChat(page)
  await drop(page, ['Old.txt'])
  await expect.poll(upload.count).toBe(1)
  await page.getByRole('button', { name: 'Remove attachment', exact: true }).click()
  await drop(page, ['Replacement.txt'])
  await expect(page.getByTestId('attachment-preview')).toHaveText(/Replacement.txt/)
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await page.getByPlaceholder('Paste invite link').fill(nip19.npubEncode('d'.repeat(64)))
  await page.getByPlaceholder('Type a message...').fill('Keep this new draft')
  upload.release()
  // Wait for both real upload requests to finish before checking the new draft.
  await expect.poll(upload.count).toBe(2)
  await page.waitForLoadState('networkidle')
  await expect(page.getByTestId('attachment-preview')).toHaveCount(0)
  await expect(page.getByPlaceholder('Type a message...')).toHaveValue('Keep this new draft')
  expect(await messages(page)).toEqual([])
})

test('folder and URL drops do not upload or replace the caption', async ({ page }) => {
  const upload = await uploads(page)
  await openChat(page)
  await page.getByPlaceholder('Type a message...').fill('Keep my caption')
  await page.getByTestId('chat-file-drop-area').evaluate(element => {
    const directory = new DataTransfer()
    directory.items.add(new File([], 'Folder'))
    // DataTransferItem wrappers are re-created when accessed in Chromium;
    // provide the directory entry at the transfer boundary itself.
    Object.defineProperty(directory, 'items', { value: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }] })
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: directory }))
  })
  await expect(page.getByRole('status')).toHaveText('Choose files, not folders')
  const uriWasCanceled = await page.getByTestId('chat-file-drop-area').evaluate(element => {
    const url = new DataTransfer()
    url.setData('text/uri-list', 'https://example.org/')
    element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: url }))
    return !element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: url }))
  })
  expect(uriWasCanceled).toBe(true)
  await expect(page.getByTestId('file-drop-highlight')).toHaveCount(0)
  await expect(page.getByTestId('attachment-preview')).toHaveCount(0)
  await expect(page.getByPlaceholder('Type a message...')).toHaveValue('Keep my caption')
  expect(upload.count()).toBe(0)
  upload.release()
})

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, type Page } from '@playwright/test'
import type { NativeDirectFiles } from './nativeDirectFiles'
import type { GroupFarmDevice } from '../group-runtime-farm'

interface HistoryOptions {
  page: Page
  native: NativeDirectFiles
  control: GroupFarmDevice
  webOwner: string
  nativeOwner: string
  webDevice: string
  receivedId: string
  sentId: string
  payloads: { filename: string; bytes: Buffer }[]
  capture: (stage: string) => Promise<void>
  openChat: () => Promise<void>
}

/** Reopen the production app with its own persisted history and local files. */
export async function verifyDirectFileHistory(options: HistoryOptions) {
  const { page, native, control, webOwner, nativeOwner, webDevice, receivedId, sentId, payloads, capture } = options
  const card = (id: string) => page.getByTestId(`direct-file-transfer-${id}`)
  const reopen = async () => {
    await page.reload()
    await options.openChat()
  }
  const completedHistory = async (missingIndex?: number) => {
    await expect(card(receivedId).getByRole('status')).toHaveText('Received')
    await expect(card(sentId).getByRole('status')).toHaveText('Sent')
    for (const file of payloads) {
      await expect(card(receivedId).getByText(file.filename, { exact: true })).toBeVisible()
      await expect(card(sentId).getByText(file.filename, { exact: true })).toBeVisible()
    }
    // The sender's original File handles lived only in the closed page.
    await expect(card(sentId).getByRole('button', { name: /^Download / })).toHaveCount(0)
    for (const [index, file] of payloads.entries()) {
      const downloadButton = card(receivedId).getByRole('button', { name: `Download ${file.filename}`, exact: true })
      if (index === missingIndex) { await expect(downloadButton).toHaveCount(0); continue }
      const pending = page.waitForEvent('download')
      await downloadButton.click()
      const downloaded = readFileSync((await (await pending).path())!)
      expect(downloaded.equals(file.bytes)).toBe(true)
    }
  }

  await reopen()
  await completedHistory()
  await capture('completed-history-reopened')

  const failedId = '3'.repeat(32)
  const failed = await native.command('offer', {
    id: failedId, token: '4'.repeat(64), owner: nativeOwner, recipient: webOwner, peer: webDevice,
    files: payloads.map(file => ({ filename: file.filename, bytes: file.bytes.toString('base64') })),
  })
  // A real source mutation after signing keeps the size but invalidates its hash.
  // The unchanged native transport sends these bytes; the browser must reject them.
  const source = path.join(native.directory, 'source', '1')
  const corrupted = readFileSync(source)
  corrupted[0] ^= 0xff
  writeFileSync(source, corrupted)
  await control.sendContact(webOwner, failed.body)
  await card(failedId).getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(card(failedId).getByRole('status')).toHaveText('Transfer failed', { timeout: 45000 })
  await expect(card(failedId).getByRole('alert')).toHaveText('These files could not be verified. Please send them again.')
  await expect(card(failedId).getByRole('button', { name: /^Download / })).toHaveCount(0)
  await capture('failed-transfer')

  await reopen()
  await completedHistory()
  await expect(card(failedId).getByRole('status')).toHaveText('Transfer failed')
  await expect(card(failedId).getByRole('alert')).toHaveText('These files could not be verified. Please send them again.')
  for (const file of payloads) await expect(card(failedId).getByText(file.filename, { exact: true })).toBeVisible()
  await expect(card(failedId).getByRole('button', { name: /^Download / })).toHaveCount(0)
  await capture('failed-history-reopened')

  // Losing a saved local file changes availability, never the historical outcome.
  await page.evaluate(async filename => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('chosen-downloads')
    await directory.removeEntry(filename)
  }, payloads[1].filename)
  await reopen()
  await completedHistory(1)
  await expect(card(failedId).getByRole('status')).toHaveText('Transfer failed')
  await capture('history-with-missing-local-file')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Attach file', exact: true }).click()
  const files = page.getByRole('button', { name: 'Files', exact: true })
  const direct = page.getByRole('button', { name: 'Send directly', exact: true })
  await expect(files).toBeVisible()
  await expect(direct).toBeVisible()
  const first = await files.boundingBox(), second = await direct.boundingBox()
  expect(first).toBeTruthy(); expect(second).toBeTruthy()
  expect(Math.abs(first!.y - second!.y)).toBeLessThanOrEqual(2)
  expect(second!.x).toBeGreaterThanOrEqual(first!.x + first!.width - 1)
  await expect(page.getByTestId('attachment-source-row')).toHaveCSS('overflow-x', 'auto')
  await capture('mobile-attachment-row')
  return { completedSenderRestored: true, completedReceiverRestored: true, failedReceiverRestored: true,
    savedDownloadsVerified: true, missingFileKeepsCompletedStatus: true, mobileActionsShareRow: true }
}

import { test, expect } from './fixtures'
import { nip19 } from 'nostr-tools'

type CaptureEvidence = { resolve: () => void; stopped: number; recorders: number; requests: number }

for (const action of ['cancel', 'switch chat'] as const) {
  test(`late microphone permission is released after ${action}`, async ({ page }) => {
    await page.addInitScript(() => {
      const evidence: CaptureEvidence = { resolve: () => {}, stopped: 0, recorders: 0, requests: 0 }
      ;(window as unknown as { captureEvidence: CaptureEvidence }).captureEvidence = evidence
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: () => {
        evidence.requests++
        return new Promise<MediaStream>(resolve => {
          evidence.resolve = () => resolve({ getTracks: () => [{ stop: () => { evidence.stopped++ } }] } as unknown as MediaStream)
        })
      } })
      // The canceled path must never construct a recorder, even if permission
      // eventually succeeds. No real microphone or audio device is accessed.
      Object.defineProperty(window, 'MediaRecorder', { value: class {
        static isTypeSupported() { return true }
        state = 'inactive'
        constructor() { evidence.recorders++ }
        start() { this.state = 'recording' }
        stop() { this.state = 'inactive' }
      } })
    })
    const dialogs: string[] = []
    page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.dismiss() })
    await page.goto('/')
    await page.getByRole('button', { name: 'Go', exact: true }).click()
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    await page.getByPlaceholder('Paste invite link').fill(nip19.npubEncode('c'.repeat(64)))
    await page.getByRole('button', { name: 'Record voice message', exact: true }).click()
    await expect(page.getByText('Requesting microphone access...')).toBeVisible()
    if (action === 'cancel') {
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    } else {
      await page.getByRole('button', { name: 'New Chat', exact: true }).click()
      await page.getByPlaceholder('Paste invite link').fill(nip19.npubEncode('d'.repeat(64)))
    }
    await expect(page.getByPlaceholder('Type a message...')).toBeVisible()
    await page.evaluate(() => (window as unknown as { captureEvidence: CaptureEvidence }).captureEvidence.resolve())
    await expect.poll(() => page.evaluate(() => {
      const evidence = (window as unknown as { captureEvidence: CaptureEvidence }).captureEvidence
      return { stopped: evidence.stopped, recorders: evidence.recorders, requests: evidence.requests }
    })).toEqual({ stopped: 1, recorders: 0, requests: 1 })
    await expect(page.getByTestId('attachment-preview')).toHaveCount(0)
    await expect(page.getByPlaceholder('Type a message...')).toHaveValue('')
    expect(dialogs).toEqual([])
  })
}

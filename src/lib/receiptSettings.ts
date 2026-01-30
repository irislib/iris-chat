import { writable } from 'svelte/store'

export interface ReceiptSettings {
  sendDeliveryReceipts: boolean
  sendReadReceipts: boolean
}

const STORAGE_KEY = 'iris-chat-receipts'

function loadSettings(): ReceiptSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      // Migrate old single-toggle format
      if ('sendReceipts' in parsed && !('sendDeliveryReceipts' in parsed)) {
        return { sendDeliveryReceipts: parsed.sendReceipts, sendReadReceipts: parsed.sendReceipts }
      }
      return parsed
    }
  } catch {}
  return { sendDeliveryReceipts: true, sendReadReceipts: true }
}

function save(settings: ReceiptSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export const receiptSettings = writable<ReceiptSettings>(loadSettings())

export function setSendDeliveryReceipts(value: boolean): void {
  receiptSettings.update(s => {
    const updated = { ...s, sendDeliveryReceipts: value }
    save(updated)
    return updated
  })
}

export function setSendReadReceipts(value: boolean): void {
  receiptSettings.update(s => {
    const updated = { ...s, sendReadReceipts: value }
    save(updated)
    return updated
  })
}

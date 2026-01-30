import { writable, get } from 'svelte/store'

export interface ReceiptSettings {
  sendReceipts: boolean
}

const STORAGE_KEY = 'iris-chat-receipts'

function loadSettings(): ReceiptSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      return JSON.parse(stored)
    }
  } catch {}
  return { sendReceipts: true }
}

export const receiptSettings = writable<ReceiptSettings>(loadSettings())

export function setSendReceipts(value: boolean): void {
  receiptSettings.update(s => {
    const updated = { ...s, sendReceipts: value }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
    return updated
  })
}

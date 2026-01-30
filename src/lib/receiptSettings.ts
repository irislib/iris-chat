import { createPersistedSettings } from './createSettings'

export interface ReceiptSettings {
  sendDeliveryReceipts: boolean
  sendReadReceipts: boolean
}

const { store, update } = createPersistedSettings<ReceiptSettings>(
  'iris-chat-receipts',
  { sendDeliveryReceipts: true, sendReadReceipts: true },
  (parsed) => {
    // Migrate old single-toggle format
    if ('sendReceipts' in parsed && !('sendDeliveryReceipts' in parsed)) {
      const val = (parsed as { sendReceipts: boolean }).sendReceipts
      return { sendDeliveryReceipts: val, sendReadReceipts: val }
    }
    return null
  },
)

export const receiptSettings = store

export function setSendDeliveryReceipts(value: boolean): void {
  update({ sendDeliveryReceipts: value })
}

export function setSendReadReceipts(value: boolean): void {
  update({ sendReadReceipts: value })
}

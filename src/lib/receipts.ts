import {
  parseReceipt as parseReceiptInner,
  shouldAdvanceReceiptStatus,
  type ReceiptPayload as NdrReceiptPayload,
  type ReceiptType,
} from 'nostr-double-ratchet/dist/nostr-double-ratchet.es.js'

export type MessageStatus = ReceiptType
export type ReceiptPayload = NdrReceiptPayload

export const parseReceipt = parseReceiptInner
export const shouldAdvanceStatus = shouldAdvanceReceiptStatus

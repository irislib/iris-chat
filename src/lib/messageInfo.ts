import type { ChatMessage, RecipientDeliveryStatus } from './chat'
import type { MessageStatus } from './receipts'

export type MessageInfoScope = 'dm' | 'group' | 'unknown'

export interface MessageInfoContext {
  myPubkey?: string | null
  recipientPubkey?: string | null
  groupMembers?: string[] | null
}

export interface MessageInfoInput {
  isMine: boolean
  status?: MessageStatus
  recipientStatuses?: Record<string, RecipientDeliveryStatus>
  senderPubkey?: string
}

export interface RecipientReceiptRow {
  pubkey: string
  status: RecipientDeliveryStatus | 'waiting'
}

export interface MessageReceiptInfo {
  scope: MessageInfoScope
  participants: string[]
  potentialRecipients: string[]
  recipientRows: RecipientReceiptRow[]
  receivedBy: string[]
  seenBy: string[]
  notes: string[]
}

export interface ReceiptStagePartition {
  deliveredBy: string[]
  seenBy: string[]
}

function uniquePubkeys(values: Array<string | null | undefined>): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  for (const value of values) {
    if (!value) continue
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }

  return out
}

export function partitionReceiptStages(receivedBy: string[], seenBy: string[]): ReceiptStagePartition {
  const uniqueSeenBy = uniquePubkeys(seenBy)
  const seenSet = new Set(uniqueSeenBy)
  const deliveredBy = uniquePubkeys(receivedBy).filter((pubkey) => !seenSet.has(pubkey))

  return {
    deliveredBy,
    seenBy: uniqueSeenBy,
  }
}

function isGroupContext(context: MessageInfoContext): boolean {
  return Array.isArray(context.groupMembers) && context.groupMembers.length > 0
}

function getScope(context: MessageInfoContext): MessageInfoScope {
  if (isGroupContext(context)) return 'group'
  if (context.recipientPubkey) return 'dm'
  return 'unknown'
}

function resolveSenderPubkey(
  message: MessageInfoInput,
  context: MessageInfoContext,
  scope: MessageInfoScope
): string | null {
  if (message.senderPubkey) return message.senderPubkey
  if (message.isMine) return context.myPubkey || null
  if (scope === 'dm') return context.recipientPubkey || null
  return null
}

function hasDelivered(status: RecipientDeliveryStatus | undefined): boolean {
  return status === 'delivered' || status === 'seen'
}

function hasSeen(status: RecipientDeliveryStatus | undefined): boolean {
  return status === 'seen'
}

function hasRecipientDelivered(status: RecipientDeliveryStatus | 'waiting' | undefined): boolean {
  return status === 'delivered' || status === 'seen'
}

function hasRecipientSeen(status: RecipientDeliveryStatus | 'waiting' | undefined): boolean {
  return status === 'seen'
}

export function deriveMessageReceiptInfo(
  message: MessageInfoInput | Pick<ChatMessage, 'isMine' | 'status' | 'recipientStatuses' | 'senderPubkey'>,
  context: MessageInfoContext
): MessageReceiptInfo {
  const scope = getScope(context)
  const notes: string[] = []

  const participants = scope === 'group'
    ? uniquePubkeys(context.groupMembers || [])
    : scope === 'dm'
      ? uniquePubkeys([context.myPubkey, context.recipientPubkey])
      : uniquePubkeys([context.myPubkey, context.recipientPubkey, message.senderPubkey])

  const senderPubkey = resolveSenderPubkey(message, context, scope)
  const potentialRecipients = senderPubkey
    ? participants.filter((p) => p !== senderPubkey)
    : [...participants]

  const receivedBy: string[] = []
  const seenBy: string[] = []
  const explicitRecipientStatuses = message.recipientStatuses || {}
  let recipientRows: RecipientReceiptRow[] = []

  if (scope === 'group') {
    recipientRows = potentialRecipients.map((pubkey) => ({
      pubkey,
      status:
        !message.isMine && pubkey === context.myPubkey
          ? message.status || 'delivered'
          : explicitRecipientStatuses[pubkey] || 'waiting',
    }))
    for (const row of recipientRows) {
      if (hasRecipientDelivered(row.status)) receivedBy.push(row.pubkey)
      if (hasRecipientSeen(row.status)) seenBy.push(row.pubkey)
    }

    if (!message.isMine && context.myPubkey) {
      receivedBy.push(context.myPubkey)
      if (hasSeen(message.status)) {
        seenBy.push(context.myPubkey)
      }
    }
  } else if (scope === 'dm') {
    if (message.isMine) {
      const recipientStatus = context.recipientPubkey
        ? explicitRecipientStatuses[context.recipientPubkey]
        : undefined
      const effectiveStatus = recipientStatus === 'sent' ? message.status : (recipientStatus || message.status)
      if (context.recipientPubkey) {
        recipientRows = [{
          pubkey: context.recipientPubkey,
          status: effectiveStatus || 'waiting',
        }]
      }
      if (hasDelivered(effectiveStatus) && context.recipientPubkey) {
        receivedBy.push(context.recipientPubkey)
      }
      if (hasSeen(effectiveStatus) && context.recipientPubkey) {
        seenBy.push(context.recipientPubkey)
      }

      if (!hasDelivered(effectiveStatus)) {
        notes.push('No delivery receipt yet.')
      }
    } else if (context.myPubkey) {
      recipientRows = [{
        pubkey: context.myPubkey,
        status: message.status || 'delivered',
      }]
      receivedBy.push(context.myPubkey)
      if (hasSeen(message.status)) {
        seenBy.push(context.myPubkey)
      }
    }
  } else {
    if (!message.isMine && context.myPubkey) {
      recipientRows = [{
        pubkey: context.myPubkey,
        status: message.status || 'delivered',
      }]
      receivedBy.push(context.myPubkey)
      if (hasSeen(message.status)) {
        seenBy.push(context.myPubkey)
      }
    }
    notes.push('Missing chat context, so receipt participants may be incomplete.')
  }

  return {
    scope,
    participants,
    potentialRecipients,
    recipientRows,
    receivedBy: uniquePubkeys(receivedBy),
    seenBy: uniquePubkeys(seenBy),
    notes: [...new Set(notes)],
  }
}

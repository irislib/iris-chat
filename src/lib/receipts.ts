export type MessageStatus = 'delivered' | 'seen'

export interface ReceiptPayload {
  type: 'delivered' | 'seen'
  messageIds: string[]
}

const STATUS_ORDER: Record<string, number> = {
  delivered: 1,
  seen: 2,
}

export function shouldAdvanceStatus(
  current: MessageStatus | undefined,
  incoming: MessageStatus
): boolean {
  const currentOrder = current ? STATUS_ORDER[current] ?? 0 : 0
  const incomingOrder = STATUS_ORDER[incoming] ?? 0
  return incomingOrder > currentOrder
}

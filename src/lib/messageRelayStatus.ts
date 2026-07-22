export type MessageRelayPublishListener = (
  messageId: string,
  relayUrls: string[]
) => void

export type RecipientDeliveryStatus = 'sent' | 'delivered' | 'seen'

const RECIPIENT_STATUS_RANK: Record<RecipientDeliveryStatus, number> = {
  sent: 1,
  delivered: 2,
  seen: 3,
}

export function mergeUniqueStrings(
  existing: string[] | undefined,
  next: string[],
): string[] {
  return Array.from(
    new Set([...(existing || []), ...next].map((value) => value.trim()).filter(Boolean))
  ).sort()
}

export function relayChannelLabel(relayUrl: string): string {
  return `message server: ${relayUrl.trim()}`
}

export function advanceRecipientStatus(
  existing: Record<string, RecipientDeliveryStatus> | undefined,
  pubkey: string,
  status: RecipientDeliveryStatus,
): Record<string, RecipientDeliveryStatus> | null {
  const previous = existing?.[pubkey]
  if ((previous ? RECIPIENT_STATUS_RANK[previous] : 0) >= RECIPIENT_STATUS_RANK[status]) return null
  return { ...(existing || {}), [pubkey]: status }
}

const listeners = new Set<MessageRelayPublishListener>()

export function onMessageRelayPublish(
  listener: MessageRelayPublishListener
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function notifyMessageRelayPublish(
  messageId: string | undefined,
  relayUrls: string[]
): void {
  if (!messageId || relayUrls.length === 0) return

  const uniqueRelayUrls = mergeUniqueStrings(undefined, relayUrls)
  if (uniqueRelayUrls.length === 0) return

  for (const listener of listeners) {
    listener(messageId, uniqueRelayUrls)
  }
}

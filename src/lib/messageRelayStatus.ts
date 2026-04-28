export type MessageRelayPublishListener = (
  messageId: string,
  relayUrls: string[]
) => void

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

  const uniqueRelayUrls = Array.from(
    new Set(relayUrls.map((url) => url.trim()).filter(Boolean))
  ).sort()
  if (uniqueRelayUrls.length === 0) return

  for (const listener of listeners) {
    listener(messageId, uniqueRelayUrls)
  }
}

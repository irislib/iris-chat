import { restoredCallHistory } from './callHistory'
import type { ChatMessage } from './chat'
import { directFileMessageFields } from './directFileProtocol'
import { messageMutationFields } from './messageMutations'
import { mergeUniqueStrings, relayChannelLabel } from './messageRelayStatus'
import type { StoredMessage } from './storage'

export function cloneReactions(
  reactions?: Record<string, string[]>,
): Record<string, string[]> | undefined {
  if (!reactions) return undefined
  const copy: Record<string, string[]> = {}
  for (const [emoji, users] of Object.entries(reactions)) {
    copy[emoji] = [...users]
  }
  return copy
}

export function storedMessageToChatMessage(
  m: StoredMessage,
  options?: { directFile?: boolean; callHistory?: boolean },
): ChatMessage {
  return {
    id: m.id,
    content: m.content,
    ...messageMutationFields(m),
    ...(options?.directFile ? directFileMessageFields(m.content) : {}),
    timestamp: m.timestamp,
    isMine: m.isMine,
    ...(m.replyTo && { replyTo: m.replyTo }),
    reactions: m.reactions,
    status: m.status,
    ...(options?.callHistory ? restoredCallHistory(m.call) : {}),
    ...(m.sentToRelays && { sentToRelays: m.sentToRelays }),
    ...(m.recipientStatuses && { recipientStatuses: m.recipientStatuses }),
    ...(m.deliveryChannels && { deliveryChannels: m.deliveryChannels }),
    ...(m.outerEventIds && { outerEventIds: m.outerEventIds }),
    ...(m.pendingRelayEventIds && { pendingRelayEventIds: m.pendingRelayEventIds }),
    senderPubkey: m.senderPubkey,
    ...(m.expiresAt !== undefined && { expiresAt: m.expiresAt }),
  }
}

export function chatMessageToStoredMessage(
  sessionId: string,
  message: ChatMessage,
): StoredMessage {
  return {
    id: message.id,
    sessionId,
    content: message.content,
    ...messageMutationFields(message),
    timestamp: message.timestamp,
    isMine: message.isMine,
    ...(message.replyTo && { replyTo: message.replyTo }),
    reactions: cloneReactions(message.reactions),
    status: message.status,
    ...(message.call && { call: message.call }),
    ...(message.sentToRelays && { sentToRelays: message.sentToRelays }),
    ...(message.recipientStatuses && { recipientStatuses: message.recipientStatuses }),
    ...(message.deliveryChannels && { deliveryChannels: message.deliveryChannels }),
    ...(message.outerEventIds && { outerEventIds: message.outerEventIds }),
    ...(message.pendingRelayEventIds && { pendingRelayEventIds: message.pendingRelayEventIds }),
    ...(message.senderPubkey !== undefined && { senderPubkey: message.senderPubkey }),
    ...(message.expiresAt !== undefined && { expiresAt: message.expiresAt }),
  }
}

export function insertMessageOrdered<T extends { timestamp: number }>(
  messages: readonly T[],
  message: T,
): T[] {
  const len = messages.length
  if (len === 0 || message.timestamp >= messages[len - 1].timestamp) {
    return [...messages, message]
  }
  let low = 0
  let high = len
  while (low < high) {
    const mid = (low + high) >>> 1
    if (messages[mid].timestamp <= message.timestamp) low = mid + 1
    else high = mid
  }
  return [...messages.slice(0, low), message, ...messages.slice(low)]
}

export function extractReplyToId(tags?: string[][]): string | undefined {
  if (!tags?.length) return undefined
  const explicit = tags.find((tag) => tag[0] === 'e' && tag[3] === 'reply')?.[1]
  if (explicit) return explicit
  if (tags.some((tag) => tag[0] === 'e' && tag[3] === 'root')) return undefined
  return tags.find((tag) => tag[0] === 'e')?.[1]
}

export function findLastMessageIndex<T extends { id: string }>(
  messages: readonly T[],
  messageId: string,
): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].id === messageId) return i
  }
  return -1
}

export function mergeRelayPublishFields(
  message: { sentToRelays?: string[]; deliveryChannels?: string[] },
  relayUrls: string[],
): { sentToRelays: string[]; deliveryChannels: string[] } | null {
  const sentToRelays = mergeUniqueStrings(message.sentToRelays, relayUrls)
  const currentRelays = message.sentToRelays || []
  const deliveryChannels = mergeUniqueStrings(
    message.deliveryChannels,
    relayUrls.map(relayChannelLabel),
  )
  const currentChannels = message.deliveryChannels || []
  if (
    sentToRelays.length === currentRelays.length &&
    sentToRelays.every((url, index) => url === currentRelays[index]) &&
    deliveryChannels.length === currentChannels.length &&
    deliveryChannels.every((channel, index) => channel === currentChannels[index])
  ) {
    return null
  }
  return { sentToRelays, deliveryChannels }
}

export function optionalModuleExport<T>(mod: unknown, key: string): T | undefined {
  try {
    return (mod as Record<string, unknown>)[key] as T | undefined
  } catch {
    return undefined
  }
}

export async function withOptionalPrivateStateCache<T>(
  owner: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (!owner) return fn()
  const mod = await import('./privateStateStore')
  const withCache = optionalModuleExport<typeof mod.withPrivateStateReadCache>(mod, 'withPrivateStateReadCache')
  return typeof withCache === 'function' ? withCache(owner, fn) : fn()
}

export interface NotificationTarget {
  chatId: string
  ownerPubkey?: string
}

const prefix = '#notification-'

export function notificationTarget(value: unknown): NotificationTarget | null {
  if (!value || typeof value !== 'object') return null
  const { chatId, ownerPubkey } = value as Record<string, unknown>
  if (typeof chatId !== 'string' || !chatId.trim() || chatId.length > 512) return null
  if (ownerPubkey !== undefined && (typeof ownerPubkey !== 'string' || !ownerPubkey)) return null
  const destination = chatId.startsWith('group:') ? chatId.slice(6) : chatId
  if (!destination) return null
  return { chatId: destination, ...(typeof ownerPubkey === 'string' ? { ownerPubkey } : {}) }
}

export function notificationHash(target: NotificationTarget): string {
  return prefix + encodeURIComponent(JSON.stringify(target))
}

export function notificationFromHash(hash: string): NotificationTarget | null {
  try {
    if (hash.startsWith(prefix)) return notificationTarget(JSON.parse(decodeURIComponent(hash.slice(prefix.length))))
    // Retain links from notifications posted by an older worker.
    if (hash.startsWith('#chat-')) return notificationTarget({ chatId: decodeURIComponent(hash.slice(6)) })
  } catch { /* Ignore malformed or truncated notification links. */ }
  return null
}

export function resolveNotificationTarget(
  target: NotificationTarget, ownerPubkey: string,
  chatIds: ReadonlySet<string>, groupIds: ReadonlySet<string>,
): 'chat' | 'group' | 'discard' | 'pending' {
  if (target.ownerPubkey && target.ownerPubkey !== ownerPubkey) return 'discard'
  if (groupIds.has(target.chatId)) return 'group'
  if (chatIds.has(target.chatId)) return 'chat'
  return 'pending'
}

import { get } from 'svelte/store'
import { db, type StoredMessage } from './storage'
import { reactionHeads, hasReactionHead } from './deviceSyncRecordStore'
import { acceptChatFromActivity, acceptChatsFromActivity, requestDecision } from './messageRequests'

function isOwnStoredMessage(owner: string, message: StoredMessage): boolean {
  return !message.call && message.isMine && (!message.senderPubkey || message.senderPubkey === owner) &&
    !!(message.content.trim() || message.deletedAt !== undefined)
}

/** Already-admitted messages retain their authored clock across replay and restart. */
export function acceptFromStoredActivity(owner: string, message: StoredMessage): void {
  if (isOwnStoredMessage(owner, message)) acceptChatFromActivity(owner, message.sessionId, message.timestamp)
}

/** Only old unversioned reactions lack a more precise authored timestamp. */
export async function restoreStoredRequestAcceptance(owner: string, message: StoredMessage): Promise<void> {
  acceptFromStoredActivity(owner, message)
  if (message.call || !Object.values(message.reactions ?? {}).some(authors => authors.includes(owner))) return
  if (!await hasReactionHead(owner, message.sessionId, message.id, owner)) acceptChatFromActivity(owner, message.sessionId, message.timestamp)
}

/** Batch-restore request acceptance across loaded messages with one storage/store update. */
export async function restoreStoredRequestAcceptances(owner: string, messages: Iterable<StoredMessage>): Promise<void> {
  const maxByChat = new Map<string, number>()
  const reactionCandidates: StoredMessage[] = []
  for (const message of messages) {
    if (message.call) continue
    if (isOwnStoredMessage(owner, message)) {
      const prev = maxByChat.get(message.sessionId) ?? 0
      if (message.timestamp > prev) maxByChat.set(message.sessionId, message.timestamp)
    } else if (Object.values(message.reactions ?? {}).some(authors => authors.includes(owner))) {
      reactionCandidates.push(message)
    }
  }
  const unchecked = reactionCandidates.filter(message => {
    const floor = Math.max(maxByChat.get(message.sessionId) ?? 0, requestDecision(owner, message.sessionId)?.updatedAtMs ?? 0)
    return message.timestamp > floor
  })
  if (unchecked.length) {
    const keys = unchecked.map(m => `device-record-v1:${owner}:reaction:${JSON.stringify([m.sessionId, m.id, owner])}`)
    const existing = await db.sessionManager.bulkGet(keys)
    for (let i = 0; i < unchecked.length; i++) {
      if (existing[i]) continue
      const message = unchecked[i]
      const prev = maxByChat.get(message.sessionId) ?? 0
      if (message.timestamp > prev) maxByChat.set(message.sessionId, message.timestamp)
    }
  }
  if (maxByChat.size) acceptChatsFromActivity(owner, maxByChat)
}

/** Recover a durable own reaction if shutdown preceded its preference projection. */
export async function restoreOwnReactionAcceptance(owner: string): Promise<void> {
  const { chats } = await import('./chat')
  const { groups } = await import('./groups')
  const knownChats = get(chats)
  const knownGroups = get(groups)
  const maxByChat = new Map<string, number>()
  for await (const reaction of reactionHeads(owner)) {
    if (reaction.author !== owner) continue
    const known = reaction.chatId.startsWith('group:')
      ? knownGroups.get(reaction.chatId.slice(6))?.members.includes(owner)
      : knownChats.has(reaction.chatId)
    if (!known) continue
    const ts = reaction.createdAtMs ?? reaction.createdAt * 1000
    if (ts > (maxByChat.get(reaction.chatId) ?? 0)) maxByChat.set(reaction.chatId, ts)
  }
  if (maxByChat.size) acceptChatsFromActivity(owner, maxByChat)
}

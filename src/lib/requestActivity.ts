import { get } from 'svelte/store'
import type { StoredMessage } from './storage'
import { reactionHeads, hasReactionHead } from './deviceSyncRecordStore'
import { acceptChatFromActivity } from './messageRequests'

/** Already-admitted messages retain their authored clock across replay and restart. */
export function acceptFromStoredActivity(owner: string, message: StoredMessage): void {
  if (message.call) return
  const ownMessage = message.isMine && (!message.senderPubkey || message.senderPubkey === owner) && (message.content.trim() || message.deletedAt !== undefined)
  if (ownMessage) acceptChatFromActivity(owner, message.sessionId, message.timestamp)
}

/** Only old unversioned reactions lack a more precise authored timestamp. */
export async function restoreStoredRequestAcceptance(owner: string, message: StoredMessage): Promise<void> {
  acceptFromStoredActivity(owner, message)
  if (message.call || !Object.values(message.reactions ?? {}).some(authors => authors.includes(owner))) return
  if (!await hasReactionHead(owner, message.sessionId, message.id, owner)) acceptChatFromActivity(owner, message.sessionId, message.timestamp)
}

/** Recover a durable own reaction if shutdown preceded its preference projection. */
export async function restoreOwnReactionAcceptance(owner: string): Promise<void> {
  const { chats } = await import('./chat')
  const { groups } = await import('./groups')
  for await (const reaction of reactionHeads(owner)) {
    if (reaction.author !== owner) continue
    const known = reaction.chatId.startsWith('group:')
      ? get(groups).get(reaction.chatId.slice(6))?.members.includes(owner)
      : get(chats).has(reaction.chatId)
    if (known) acceptChatFromActivity(owner, reaction.chatId, reaction.createdAtMs ?? reaction.createdAt * 1000)
  }
}

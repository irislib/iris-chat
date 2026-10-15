import { db, isHistoryChatDeleted } from './storage'
import { isPrivatelyBlocked, privateHistoryAllowed } from './privateStateStore'

/** Durable admission checks shared by relay notifications and decrypted pushes. */
export async function messageNotificationAllowed(owner: string, message: {
  chatId: string; messageId?: string; author?: string; createdAtSecs?: number;
  expiresAt?: number; deletedAt?: number;
}): Promise<boolean> {
  const activeOwner = (await db.sessionManager.get('v1/device-manager/owner-pubkey'))?.value
  if (activeOwner && activeOwner !== owner) return false
  const stored = message.messageId ? await db.messages.get(message.messageId) : undefined
  if (stored && stored.sessionId !== message.chatId) return false
  if (message.deletedAt !== undefined || stored?.deletedAt !== undefined) return false
  const expiry = message.expiresAt ?? stored?.expiresAt
  if (expiry !== undefined && expiry <= Date.now() / 1000) return false
  if (message.messageId && await db.sessionManager.get(`history-deleted-message:${message.messageId}`)) return false
  if (await isHistoryChatDeleted(message.chatId,message.createdAtSecs)) return false
  if (message.chatId.startsWith('group:')) {
    const group = await db.groups.get(message.chatId.slice(6))
    if (!group || group.accepted === false || !group.members.includes(owner) || message.author && !group.members.includes(message.author)) return false
  } else if (await isPrivatelyBlocked(owner,message.chatId)) return false
  if (message.author) {
    if (await isPrivatelyBlocked(owner,message.author)) return false
    if (message.createdAtSecs !== undefined && !await privateHistoryAllowed(owner,message.author,message.createdAtSecs)) return false
  }
  return true
}

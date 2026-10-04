import { get } from 'svelte/store'
import { getEventHash } from 'nostr-tools'
import type { Rumor } from 'nostr-double-ratchet'
import { db, type StoredMessage } from './storage'
import { compareControlHead, type DeviceSyncMessageMutation } from './deviceSyncRecords'
import { deviceRecordVersion } from './deviceSyncRecordStore'
import { messageDeletionSettings } from './messageDeletionSettings'

export const MESSAGE_EDIT_KIND = 1009
export const MESSAGE_DELETE_KIND = 5
const validMessageId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128
export interface MessageRevision { id: string; content: string; timestamp: number }
export function messageMutationFields(message: Pick<StoredMessage, 'originalContent' | 'editHistory' | 'editedAt' | 'deletedAt'>) {
  return { originalContent: message.originalContent, editHistory: message.editHistory, editedAt: message.editedAt, deletedAt: message.deletedAt }
}
export function editableMessage(message: { call?: unknown; directTransferId?: string; content: string; deletedAt?: number }): boolean {
  return !message.call && !message.directTransferId && message.deletedAt === undefined && !!message.content.trim() &&
    !/(?:iris-direct-file-v1:|nhash1|htree:\/\/|"type"\s*:\s*"(?:file|direct-file)|!\[[^\]]*\]\()/i.test(message.content)
}
export function mutationFromRumor(chatId: string, rumor: Rumor, author: string): DeviceSyncMessageMutation | undefined {
  if (!Number.isSafeInteger(rumor.created_at) || rumor.created_at < 0) return
  if (rumor.kind !== MESSAGE_EDIT_KIND && rumor.kind !== MESSAGE_DELETE_KIND || !/^[a-f0-9]{64}$/.test(rumor.id) || getEventHash(rumor) !== rumor.id) return
  const targets = rumor.tags.filter(tag => tag[0] === 'e'), kinds = rumor.tags.filter(tag => tag[0] === 'k')
  if (targets.length !== 1 || !validMessageId(targets[0][1]) || targets[0][1] === rumor.id || kinds.length !== 1 || kinds[0][1] !== '14') return
  if (rumor.kind === MESSAGE_EDIT_KIND ? !rumor.content.trim() || new TextEncoder().encode(rumor.content).length > 32768 : rumor.content !== '') return
  const msTags = rumor.tags.filter(tag => tag[0] === 'ms')
  if (msTags.length > 1 || msTags.length === 1 && !/^\d+$/.test(msTags[0][1] ?? '')) return
  const ms = msTags.length ? Number(msTags[0][1]) : undefined
  if (ms !== undefined && (!Number.isSafeInteger(ms) || Math.floor(ms / 1000) !== rumor.created_at)) return
  const expiration = rumor.tags.find(tag => tag[0] === 'expiration')?.[1]
  const expiresAt = expiration === undefined ? undefined : Number(expiration)
  if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt < 0)) return
  return { chatId, id: rumor.id, author, messageId: targets[0][1], createdAt: rumor.created_at,
    ...(ms !== undefined && Number.isSafeInteger(ms) && ms >= 0 && Math.floor(ms / 1000) === rumor.created_at && { createdAtMs: ms }),
    operation: rumor.kind === MESSAGE_EDIT_KIND ? 'edit' : 'delete', content: rumor.content, ...(expiresAt !== undefined && { expiresAt }) }
}
const base = (owner: string) => `device-record-v1:${owner}:messageMutation:`
const key = (owner: string, chatId: string, id: string) => base(owner) + JSON.stringify([chatId, id])
const targetKey = (owner: string, chatId: string, id: string) => `message-mutation-target:${owner}:${JSON.stringify([chatId, id])}`
export async function messageMutation(owner: string, chatId: string, id: string): Promise<DeviceSyncMessageMutation | undefined> {
  return (await db.sessionManager.get(key(owner, chatId, id)))?.value as DeviceSyncMessageMutation | undefined
}
export async function* messageMutationRecords(owner: string): AsyncGenerator<DeviceSyncMessageMutation> {
  const prefix = base(owner)
  let after: string | undefined
  while (true) {
    const rows = await db.sessionManager.where('key').between(after ?? prefix, prefix + '\uffff', after === undefined, true).limit(256).toArray()
    for (const row of rows) {
      const mutation = row.value as DeviceSyncMessageMutation
      if (mutation.expiresAt === undefined || mutation.expiresAt > Date.now() / 1000) yield mutation
    }
    if (rows.length < 256) return
    after = rows.at(-1)!.key
  }
}
async function targetMutations(owner: string, message: Pick<StoredMessage, 'sessionId' | 'id'>): Promise<DeviceSyncMessageMutation[]> {
  const ids = (await db.sessionManager.get(targetKey(owner, message.sessionId, message.id)))?.value as string[] | undefined
  if (!ids?.length) return []
  return (await db.sessionManager.bulkGet(ids.map(id => key(owner, message.sessionId, id)))).flatMap(row => row ? [row.value as DeviceSyncMessageMutation] : [])
}
function originalAuthor(owner: string, message: StoredMessage): string | undefined {
  return message.isMine ? owner : message.senderPubkey ?? (message.sessionId.startsWith('group:') ? undefined : message.sessionId)
}
export function projectMessageMutations(owner: string, message: StoredMessage, records: DeviceSyncMessageMutation[]): StoredMessage {
  if (message.deletedAt !== undefined) return { ...message, content: '', originalContent: undefined, editHistory: undefined, editedAt: undefined, reactions: undefined, replyTo: undefined }
  const author = originalAuthor(owner, message)
  const valid = records.filter(record => record.chatId === message.sessionId && record.messageId === message.id && record.author === author && record.createdAt >= Math.floor(message.timestamp / 1000) && (record.expiresAt === undefined || record.expiresAt > Date.now() / 1000))
  const deletion = valid.filter(record => record.operation === 'delete').sort(compareControlHead).at(-1)
  if (deletion) return { ...message, content: '', originalContent: undefined, editHistory: undefined, editedAt: undefined,
    deletedAt: deletion.createdAtMs ?? deletion.createdAt * 1000, reactions: undefined, replyTo: undefined }
  if (!editableMessage(message)) return message
  const edits = valid.filter(record => record.operation === 'edit').sort(compareControlHead)
  if (!edits.length) return message
  const originalContent = message.originalContent ?? message.content
  const history = [{ id: message.id, content: originalContent, timestamp: message.timestamp }, ...edits.map(record => ({
    id: record.id, content: record.content, timestamp: record.createdAtMs ?? record.createdAt * 1000,
  }))]
  return { ...message, originalContent, content: history.at(-1)!.content, editHistory: history, editedAt: history.at(-1)!.timestamp }
}
export async function messageWithMutations(owner: string, message: StoredMessage): Promise<StoredMessage> {
  const stored = await db.messages.get(message.id)
  const original = stored?.sessionId === message.sessionId ? { ...message, ...messageMutationFields(stored), content: stored.originalContent ?? stored.content } : message
  const projected = projectMessageMutations(owner, original, await targetMutations(owner, original))
  if (projected.deletedAt !== undefined) await purgeDeletedEdits(owner, projected)
  return projected
}
async function purgeDeletedEdits(owner: string, message: StoredMessage): Promise<void> {
  const records = await targetMutations(owner, message)
  const retained = records.filter(record => record.operation === 'delete' && record.author === originalAuthor(owner, message))
  await db.sessionManager.bulkDelete(records.filter(record => !retained.includes(record)).map(record => key(owner, record.chatId, record.id)))
  await db.sessionManager.put({ key: targetKey(owner, message.sessionId, message.id), value: retained.map(record => record.id) })
}
export async function refreshMessageMutationView(message: StoredMessage): Promise<void> {
  const patch = { content: message.content, ...messageMutationFields(message), reactions: message.reactions,
    ...(message.deletedAt !== undefined && { directTransferId: undefined, replyTo: undefined }) }
  if (message.sessionId.startsWith('group:')) {
    const { groupMessages } = await import('./groups')
    groupMessages.update(all => {
      const id = message.sessionId.slice(6), rows = all.get(id)
      return rows ? new Map(all).set(id, rows.map(row => row.id === message.id ? { ...row, ...patch } : row)) : all
    })
  } else {
    const { chats, currentChat } = await import('./chat')
    chats.update(all => {
      const chat = all.get(message.sessionId)
      if (!chat) return all
      const updated = { ...chat, messages: chat.messages.map(row => row.id === message.id ? { ...row, ...patch } : row) }
      if (get(currentChat)?.id === chat.id) currentChat.set(updated)
      return new Map(all).set(chat.id, updated)
    })
  }
}
export async function applyMessageMutation(owner: string, mutation: DeviceSyncMessageMutation, authorized = () => true): Promise<boolean> {
  if (!authorized() || mutation.createdAt > Date.now() / 1000 + 300 || mutation.expiresAt !== undefined && mutation.expiresAt <= Date.now() / 1000) return false
  if (mutation.operation === 'delete' && mutation.author !== owner && !get(messageDeletionSettings).allowDeletionByOthers) return false
  if (mutation.chatId.startsWith('group:')) {
    const { groups } = await import('./groups')
    const group = get(groups).get(mutation.chatId.slice(6))
    if (!group?.members.includes(owner) || !group.members.includes(mutation.author)) return false
  } else if (mutation.author !== owner && mutation.author !== mutation.chatId) return false
  let updated: StoredMessage | undefined
  const changed = await db.transaction('rw', db.messages, db.sessionManager, async () => {
    if (!authorized() || await db.sessionManager.get(key(owner, mutation.chatId, mutation.id))) return false
    const target = await db.messages.get(mutation.messageId)
    if (target && (target.sessionId !== mutation.chatId || originalAuthor(owner, target) !== mutation.author || mutation.createdAt < Math.floor(target.timestamp / 1000) || target.call ||
      target.expiresAt !== undefined && target.expiresAt <= Date.now() / 1000 || target.deletedAt !== undefined ||
      mutation.operation === 'edit' && !editableMessage(target))) return false
    if (await db.sessionManager.get(`history-deleted-message:${mutation.messageId}`) || await db.sessionManager.get(`history-deleted-chat:${mutation.chatId}`)) return false
    const indexKey = targetKey(owner, mutation.chatId, mutation.messageId)
    const ids = (await db.sessionManager.get(indexKey))?.value as string[] | undefined ?? []
    if (!authorized()) return false
    await db.sessionManager.put({ key: key(owner, mutation.chatId, mutation.id), value: mutation })
    await db.sessionManager.put({ key: indexKey, value: [...ids, mutation.id] })
    if (target) {
      updated = projectMessageMutations(owner, target, await targetMutations(owner, target))
      if (updated.deletedAt !== undefined) await purgeDeletedEdits(owner, updated)
      await db.messages.put(updated)
    }
    return true
  })
  if (changed) {
    deviceRecordVersion.update(version => version + 1)
    if (updated) await refreshMessageMutationView(updated)
  }
  return changed
}
export async function captureMessageMutation(owner: string, chatId: string, rumor: Rumor, author: string): Promise<boolean> {
  // Own-device copies bypass the private history choice and can replay when a
  // new sibling joins. Local changes apply after send acceptance; siblings
  // receive them only through the guarded typed history reconciliation.
  if (author === owner) return false
  const mutation = mutationFromRumor(chatId, rumor, author)
  return mutation ? applyMessageMutation(owner, mutation) : false
}
export async function sendMessageMutation(owner: string, chatId: string, rumor: Rumor, send: () => Promise<unknown>, authorized: () => boolean): Promise<void> {
  // The encrypted runtime must accept the control before the UI reports success.
  await send()
  if (!authorized()) throw new Error('The account changed. Try again.')
  const mutation = mutationFromRumor(chatId, rumor, owner)
  if (!mutation) throw new Error('Could not save this message update. Try again.')
  if (!await applyMessageMutation(owner, mutation, authorized)) {
    const existing = await messageMutation(owner, chatId, rumor.id)
    if (!existing || !(Object.keys(mutation) as Array<keyof DeviceSyncMessageMutation>).every(key => existing[key] === mutation[key])) throw new Error('Could not save this message update. Try again.')
  }
}
export function buildMessageMutation(author: string, messageId: string, operation: 'edit' | 'delete', content: string, scope: string[], nowMs = Date.now(), expiresAt?: number): Rumor {
  if (!validMessageId(messageId)) throw new Error('This message cannot be changed.')
  if (operation === 'edit' && (!content.trim() || new TextEncoder().encode(content).length > 32768)) throw new Error('Enter a message shorter than 32 KB.')
  const rumor: Rumor = { pubkey: author, kind: operation === 'edit' ? MESSAGE_EDIT_KIND : MESSAGE_DELETE_KIND,
    created_at: Math.floor(nowMs / 1000), content: operation === 'delete' ? '' : content,
    tags: [['e', messageId], ['k', '14'], scope, ['ms', String(nowMs)], ...(expiresAt !== undefined ? [['expiration', String(expiresAt)]] : [])], id: '' }
  rumor.id = getEventHash(rumor)
  return rumor
}

import { writable } from 'svelte/store'
import type { Event } from 'nostr-tools'
import { db, type StoredMessage } from './storage'
import { compareControlHead, verifiedProfileEvent, type DeviceSyncReaction, type DeviceSyncGroupSettings } from './deviceSyncRecords'

const MAX_HEADS = 100_000
export const deviceRecordVersion = writable(0)
const prefix = (owner: string, type = '') => `device-record-v1:${owner}:${type}`
const reactionKey = (owner: string, r: DeviceSyncReaction) => prefix(owner, `reaction:${JSON.stringify([r.chatId, r.messageId, r.author])}`)
const changed = () => deviceRecordVersion.update(value => value + 1)

async function boundedPut(key: string, value: unknown, owner: string): Promise<void> {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 64 * 1024) throw new Error('Device record exceeds storage limit')
  if (!await db.sessionManager.get(key) && await db.sessionManager.where('key').startsWith(prefix(owner)).count() >= MAX_HEADS) throw new Error('Device record head limit exceeded')
  await db.sessionManager.put({ key, value })
}

export async function reactionHeads(owner: string): Promise<DeviceSyncReaction[]> {
  return heads<DeviceSyncReaction>(owner, 'reaction:')
}
export async function groupSettingsHeads(owner: string): Promise<DeviceSyncGroupSettings[]> {
  return heads<DeviceSyncGroupSettings>(owner, 'groupSettings:')
}
async function heads<T>(owner: string, type: string): Promise<T[]> {
  const rows = await db.sessionManager.where('key').startsWith(prefix(owner, type)).limit(MAX_HEADS + 1).toArray()
  if (rows.length > MAX_HEADS) throw new Error('Device record head limit exceeded')
  return rows.map(row => row.value as T)
}

export function projectReactionHeads(message: StoredMessage, records: DeviceSyncReaction[]): StoredMessage {
  const reactions = Object.fromEntries(Object.entries(message.reactions ?? {}).map(([emoji, authors]) => [emoji, [...authors]]))
  for (const record of records) {
    if (record.chatId !== message.sessionId || record.messageId !== message.id) continue
    for (const emoji of Object.keys(reactions)) {
      reactions[emoji] = reactions[emoji].filter(author => author !== record.author)
      if (!reactions[emoji].length) delete reactions[emoji]
    }
    if (record.emoji) reactions[record.emoji] = [...(reactions[record.emoji] ?? []), record.author]
  }
  return { ...message, reactions }
}

/** Empty emoji heads remain durable even if the target has not arrived yet. */
export async function saveReactionHead(owner: string, reaction: DeviceSyncReaction, authorized = () => true): Promise<boolean> {
  const result = await db.transaction('rw', db.sessionManager, db.messages, async () => {
    if (!authorized()) return false
    const key = reactionKey(owner, reaction)
    const previous = (await db.sessionManager.get(key))?.value as DeviceSyncReaction | undefined
    if (previous && compareControlHead(previous, reaction) >= 0) return false
    const target = await db.messages.get(reaction.messageId)
    if (target && (target.sessionId !== reaction.chatId || target.expiresAt !== undefined && target.expiresAt <= Date.now() / 1000)) return false
    if (await db.sessionManager.get(`history-deleted-message:${reaction.messageId}`) || await db.sessionManager.get(`history-deleted-chat:${reaction.chatId}`)) return false
    if (!authorized()) return false
    await boundedPut(key, reaction, owner)
    if (target) await db.messages.put(projectReactionHeads(target, [reaction]))
    return true
  })
  if (result) changed()
  return result
}

export async function messageWithReactionHeads(owner: string, message: StoredMessage): Promise<StoredMessage> {
  const partialKey = JSON.stringify([message.sessionId, message.id]).slice(0, -1) + ','
  return projectReactionHeads(message, await heads<DeviceSyncReaction>(owner, `reaction:${partialKey}`))
}

export async function hasReactionHead(owner: string, chatId: string, messageId: string, author: string): Promise<boolean> {
  return !!await db.sessionManager.get(reactionKey(owner, { chatId, messageId, author } as DeviceSyncReaction))
}

export async function saveGroupSettingsHead(owner: string, settings: DeviceSyncGroupSettings, authorized = () => true): Promise<boolean> {
  const result = await db.transaction('rw', db.sessionManager, async () => {
    if (!authorized()) return false
    const key = prefix(owner, `groupSettings:${settings.groupId}`)
    const previous = (await db.sessionManager.get(key))?.value as DeviceSyncGroupSettings | undefined
    if (previous && compareControlHead(previous, settings) >= 0) return false
    if (await db.sessionManager.get(`history-deleted-chat:group:${settings.groupId}`) || !authorized()) return false
    await boundedPut(key, settings, owner)
    return true
  })
  if (result) changed()
  return result
}

export async function signedProfileHeads(owner: string, contacts: Set<string>): Promise<Event[]> {
  if (contacts.size > MAX_HEADS) throw new Error('Contact record limit exceeded')
  const rows = await db.sessionManager.bulkGet([...contacts].map(pubkey => prefix(owner, `profile:${pubkey}`)))
  return rows.flatMap(row => { const event = verifiedProfileEvent(row?.value); return event ? [event] : [] })
}

export async function saveSignedProfileHead(owner: string, value: unknown, contacts?: Set<string>, authorized = () => true): Promise<boolean> {
  const event = verifiedProfileEvent(value)
  if (!event || contacts && !contacts.has(event.pubkey)) return false
  const result = await db.transaction('rw', db.sessionManager, async () => {
    if (!authorized()) return false
    const key = prefix(owner, `profile:${event.pubkey}`)
    const previous = verifiedProfileEvent((await db.sessionManager.get(key))?.value)
    if (previous && (previous.created_at > event.created_at || previous.created_at === event.created_at && previous.id <= event.id)) return false
    await boundedPut(key, event, owner)
    return true
  })
  if (result) changed()
  return result
}

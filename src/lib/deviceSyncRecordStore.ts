import { writable } from 'svelte/store'
import type { Event } from 'nostr-tools'
import { db, type StoredMessage } from './storage'
import { compareControlHead, verifiedProfileEvent, type DeviceSyncReaction, type DeviceSyncGroupSettings } from './deviceSyncRecords'

export const deviceRecordVersion = writable(0)
const prefix = (owner: string, type = '') => `device-record-v1:${owner}:${type}`
const reactionKey = (owner: string, r: DeviceSyncReaction) => prefix(owner, `reaction:${JSON.stringify([r.chatId, r.messageId, r.author])}`)
const changed = () => deviceRecordVersion.update(value => value + 1)

async function boundedPut(key: string, value: unknown): Promise<void> {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 64 * 1024) throw new Error('Device record exceeds storage limit')
  await db.sessionManager.put({ key, value })
}

export function reactionHeads(owner: string): AsyncGenerator<DeviceSyncReaction> { return heads(owner, 'reaction:') }
export function reactionHeadPages(owner: string): AsyncGenerator<DeviceSyncReaction[]> { return headPages(owner, 'reaction:') }
export function groupSettingsHeads(owner: string): AsyncGenerator<DeviceSyncGroupSettings> { return heads(owner, 'groupSettings:') }
async function* heads<T>(owner: string, type: string): AsyncGenerator<T> {
  for await (const page of headPages<T>(owner, type)) yield* page
}
async function* headPages<T>(owner: string, type: string): AsyncGenerator<T[]> {
  const base = prefix(owner, type)
  let after: string | undefined
  while (true) {
    const rows = await db.sessionManager.where('key').between(after ?? base, `${base}\uffff`, after === undefined, true).limit(256).toArray()
    yield rows.map(row => row.value as T)
    if (rows.length < 256) return
    after = rows.at(-1)!.key
  }
}
export async function reactionHead(owner: string, key: Pick<DeviceSyncReaction, 'chatId' | 'messageId' | 'author'>): Promise<DeviceSyncReaction | undefined> {
  return (await db.sessionManager.get(reactionKey(owner, key as DeviceSyncReaction)))?.value as DeviceSyncReaction | undefined
}
export async function groupSettingsHead(owner: string, groupId: string): Promise<DeviceSyncGroupSettings | undefined> {
  return (await db.sessionManager.get(prefix(owner, `groupSettings:${groupId}`)))?.value as DeviceSyncGroupSettings | undefined
}

const authoredControls = new Map<string, Promise<unknown>>()
/** Serialize local intent and advance its signed clock beyond the durable head. */
export function withDeviceControlClock<T>(owner: string,
  target: string | Pick<DeviceSyncReaction, 'chatId' | 'messageId' | 'author'>,
  author: (nowMs: number) => Promise<T>): Promise<T> {
  const key = typeof target === 'string' ? prefix(owner, `groupSettings:${target}`) : reactionKey(owner, target as DeviceSyncReaction)
  const operation = (authoredControls.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const head = typeof target === 'string' ? await groupSettingsHead(owner, target) : await reactionHead(owner, target)
    return author(Math.max(Date.now(), head ? (head.createdAtMs ?? head.createdAt * 1000) + 1 : 0))
  })
  authoredControls.set(key, operation)
  void operation.finally(() => { if (authoredControls.get(key) === operation) authoredControls.delete(key) }).catch(() => undefined)
  return operation
}

export function projectReactionHeads(message: StoredMessage, records: DeviceSyncReaction[]): StoredMessage {
  if (message.deletedAt !== undefined) return message
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
    await boundedPut(key, reaction)
    if (target) await db.messages.put(projectReactionHeads(target, [reaction]))
    return true
  })
  if (result) changed()
  return result
}

export async function messageWithReactionHeads(owner: string, message: StoredMessage): Promise<StoredMessage> {
  const partialKey = JSON.stringify([message.sessionId, message.id]).slice(0, -1) + ','
  let projected = message
  for await (const head of heads<DeviceSyncReaction>(owner, `reaction:${partialKey}`)) projected = projectReactionHeads(projected, [head])
  return projected
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
    await boundedPut(key, settings)
    return true
  })
  if (result) changed()
  return result
}

export async function signedProfileHeads(owner: string, contacts: Set<string>): Promise<Event[]> {
  const events: Event[] = []
  const keys = [...contacts]
  for (let index = 0; index < keys.length; index += 64) {
    const rows = await db.sessionManager.bulkGet(keys.slice(index, index + 64).map(pubkey => prefix(owner, `profile:${pubkey}`)))
    for (const row of rows) { const event = verifiedProfileEvent(row?.value); if (event) events.push(event) }
  }
  return events
}

export async function saveSignedProfileHead(owner: string, value: unknown, contacts?: Set<string>, authorized = () => true): Promise<boolean> {
  const event = verifiedProfileEvent(value)
  if (!event || contacts && !contacts.has(event.pubkey)) return false
  const result = await db.transaction('rw', db.sessionManager, async () => {
    if (!authorized()) return false
    const key = prefix(owner, `profile:${event.pubkey}`)
    const previous = verifiedProfileEvent((await db.sessionManager.get(key))?.value)
    if (previous && (previous.created_at > event.created_at || previous.created_at === event.created_at && previous.id <= event.id)) return false
    await boundedPut(key, event)
    return true
  })
  if (result) changed()
  return result
}

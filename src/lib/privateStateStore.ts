import { dismissReadNotification } from './readNotifications'
import { blockedContacts, replaceBlockedContacts } from './privateBlockProjection'
import { writable } from 'svelte/store'
import { parsePrivateEvent, type PrivateEvent } from 'nostr-social-graph/privateEvents'
import { db, isHistoryChatDeleted, type StoredMessage } from './storage'
import { privateEventState, comparePrivateEvents, blockedIntervals, validMessageRead, type NameApproval, type BlockState, type MessageReadState } from './privateStateProtocol'
import { deviceRecordVersion } from './deviceRecordVersion'
import type { DeviceSyncRecord } from './deviceSyncRecords'
const base = (owner: string) => `private-state-v1:${owner}:`
const readKey = (owner: string, chat: string, id: string) => `${base(owner)}read:${JSON.stringify([chat, id])}`
export const privateStateVersion = writable(0)
let directPublicationCanceler: ((owner: string, target: string) => void) | undefined
export function registerDirectPublicationCanceler(fn: (owner: string, target: string) => void): void {
  directPublicationCanceler = fn
}
interface PrivateStateReadCache {
  owner: string
  refs: number
  blocks?: Promise<Map<string, Array<[number, number | null]>>>
  reads?: Promise<Map<string, Map<string, MessageReadState>>>
}
let readCache: PrivateStateReadCache | undefined
const invalidateReadCache = (owner?: string) => {
  if (readCache && (!owner || readCache.owner === owner)) { readCache.blocks = undefined; readCache.reads = undefined }
}
export async function withPrivateStateReadCache<T>(owner: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  if (!owner) return fn()
  const existing = readCache?.owner === owner ? readCache : undefined
  const active = existing ?? { owner, refs: 0 }
  active.refs++
  if (!existing) readCache = active
  try { return await fn() } finally {
    active.refs--
    if (readCache === active && active.refs <= 0) readCache = undefined
  }
}
export function cachedPrivateStateOwner(): string | undefined { return readCache?.owner }
const changed = (owner?: string) => { invalidateReadCache(owner); privateStateVersion.update(n => n + 1); deviceRecordVersion.update(n => n + 1) }
export async function* privateStateEvents(owner: string): AsyncGenerator<PrivateEvent> {
  const prefix = `${base(owner)}event:`
  let after: string | undefined
  while (true) {
    const rows = await db.sessionManager.where('key').between(after ?? prefix, `${prefix}\uffff`, after === undefined, true).limit(256).toArray()
    for (const row of rows) { let event: PrivateEvent; try { event = parsePrivateEvent(row.value, true) } catch { continue }; if (privateEventState(event)?.owner === owner) { if ('sig' in (row.value as object)) await db.sessionManager.put({ key: row.key, value: event }); yield event } }
    if (rows.length < 256) return
    after = rows.at(-1)!.key
  }
}
export async function contactPrivateEvents(owner: string, target: string, kind: number): Promise<PrivateEvent[]> {
  const prefix = `${base(owner)}event:${kind}:${target}:`
  const rows = await db.sessionManager.where('key').startsWith(prefix).toArray()
  return rows.flatMap(row => { try { return [parsePrivateEvent(row.value, true)] } catch { return [] } }).filter(event => privateEventState(event)?.owner === owner).sort(comparePrivateEvents)
}
export async function savePrivateStateEvent(owner: string, event: PrivateEvent, authorized: () => boolean): Promise<boolean> {
  event = parsePrivateEvent(event, true)
  if (!authorized() || privateEventState(event)?.owner !== owner) throw new Error('Invalid private account event')
  const eventState = privateEventState(event)!
  const target = 'contact' in eventState ? eventState.contact : eventState.target
  const key = `${base(owner)}event:${event.kind}:${target}:${event.id}`
  const inserted = await db.transaction('rw', db.sessionManager, async () => {
    if (!authorized()) throw new Error('Account changed')
    const previous = await db.sessionManager.get(key)
    if (previous) {
      if ('sig' in (previous.value as object)) await db.sessionManager.put({ key, value: event })
      return false
    }
    await db.sessionManager.put({ key, value: event }); return true
  })
  // Projection is repeatable if persistence succeeded before a crash/account switch.
  if (authorized() && event.kind === 10455) await projectNameApproval(owner, (privateEventState(event) as NameApproval).contact)
  if (authorized() && event.kind === 10454) {
    const next = new Set(blockedContacts(owner))
    if (await isPrivatelyBlocked(owner, target)) next.add(target); else next.delete(target)
    if (authorized()) {
      replaceBlockedContacts(owner, next)
      directPublicationCanceler?.(owner, target)
    }
  }
  if (inserted) changed(owner)
  return inserted
}
export async function projectNameApproval(owner: string, contact: string): Promise<void> {
  const events = await contactPrivateEvents(owner, contact, 10455)
  const head = events.at(-1)
  if (!head) return
  const approval = privateEventState(head) as NameApproval
  const key = `iris-contact-memory:v1:${owner}:${contact}`
  const memory = JSON.parse(localStorage.getItem(key) ?? '{}')
  const changes = new Map<string, NameApproval['change']>()
  for (const event of events) { const change = (privateEventState(event) as NameApproval).change; changes.set(JSON.stringify(change), change) }
  const next = { ...memory, first_seen_name: approval.firstSeenName, accepted_name: approval.change.accepted_name,
    name_changes: [...changes.values()].sort((a,b) => a.accepted_at_secs - b.accepted_at_secs || (a.previous_name < b.previous_name ? -1 : Number(a.previous_name > b.previous_name)) || (a.accepted_name < b.accepted_name ? -1 : Number(a.accepted_name > b.accepted_name))) }
  localStorage.setItem(key, JSON.stringify(next))
  const worker = (await db.sessionManager.get(key))?.value as Record<string, unknown> | undefined
  await db.sessionManager.put({ key, value: { ...worker, ...next } })
}
export async function isPrivatelyBlocked(owner: string, target: string): Promise<boolean> {
  const event = (await contactPrivateEvents(owner, target, 10454)).at(-1)
  return !!event && (privateEventState(event) as BlockState).blocked
}
/** Match native: retire sends through every block interval; hold newer work during catch-up. */
export async function privateDirectPublicationPolicy(owner: string, target: string, createdAt: number): Promise<boolean | 'hold'> {
  const events = await contactPrivateEvents(owner, target, 10454)
  const cutoff = Math.max(0, ...events.map(event => (privateEventState(event) as BlockState).deletedAt),
    ...blockedIntervals(events).map(([since, until]) => until === null ? since : until - 1))
  if (cutoff > 0 && createdAt <= cutoff) return false
  return events.length && (privateEventState(events.at(-1)!) as BlockState).blocked ? 'hold' : true
}
export function isTimestampBlocked(intervals: Array<[number, number | null]> | undefined, created: number): boolean {
  return !!intervals?.some(([since, until]) => created >= since && (until === null || created < until))
}
export async function loadBlockedIntervalsMap(owner: string): Promise<Map<string, Array<[number, number | null]>>> {
  if (readCache?.owner === owner) return readCache.blocks ??= fetchBlockedIntervalsMap(owner)
  return fetchBlockedIntervalsMap(owner)
}
async function fetchBlockedIntervalsMap(owner: string): Promise<Map<string, Array<[number, number | null]>>> {
  const rows = await db.sessionManager.where('key').startsWith(`${base(owner)}event:10454:`).toArray()
  const byTarget = new Map<string, PrivateEvent[]>()
  for (const row of rows) {
    let event: PrivateEvent
    try { event = parsePrivateEvent(row.value, true) } catch { continue }
    const state = privateEventState(event)
    if (state?.owner !== owner || !('target' in state)) continue
    let list = byTarget.get(state.target)
    if (!list) { list = []; byTarget.set(state.target, list) }
    list.push(event)
  }
  const intervals = new Map<string, Array<[number, number | null]>>()
  for (const [target, events] of byTarget) intervals.set(target, blockedIntervals(events))
  return intervals
}
export async function loadPendingReadsMap(owner: string, sessionId?: string): Promise<Map<string, Map<string, MessageReadState>>> {
  if (!sessionId && readCache?.owner === owner) return readCache.reads ??= fetchPendingReadsMap(owner)
  if (sessionId && readCache?.owner === owner) {
    const all = await (readCache.reads ??= fetchPendingReadsMap(owner))
    const single = all.get(sessionId)
    return single ? new Map([[sessionId, single]]) : new Map()
  }
  return fetchPendingReadsMap(owner, sessionId)
}
async function fetchPendingReadsMap(owner: string, sessionId?: string): Promise<Map<string, Map<string, MessageReadState>>> {
  const readPrefix = `${base(owner)}read:`
  const scanPrefix = sessionId ? `${readPrefix}${JSON.stringify([sessionId]).slice(0, -1)},` : readPrefix
  const rows = await db.sessionManager.where('key').startsWith(scanPrefix).toArray()
  const nowSecs = Date.now() / 1000
  const byChat = new Map<string, Map<string, MessageReadState>>()
  for (const row of rows) {
    const read = row.value as MessageReadState | undefined
    if (!validMessageRead(read) || (read.expiresAtSecs !== undefined && read.expiresAtSecs <= nowSecs)) continue
    let parsed: [string, string]
    try { parsed = JSON.parse(row.key.slice(readPrefix.length)) } catch { continue }
    const [chatId, messageId] = parsed
    let map = byChat.get(chatId)
    if (!map) { map = new Map(); byChat.set(chatId, map) }
    map.set(messageId, read)
  }
  return byChat
}
export async function privateHistoryAllowed(owner: string, author: string, created: number): Promise<boolean> {
  if (author === owner) return true
  if (readCache?.owner === owner) return !isTimestampBlocked((await loadBlockedIntervalsMap(owner)).get(author), created)
  return !isTimestampBlocked(blockedIntervals(await contactPrivateEvents(owner, author, 10454)), created)
}
export async function readState(owner: string, chatId: string, messageId: string): Promise<MessageReadState | undefined> {
  const message = await db.messages.get(messageId)
  if (message?.sessionId === chatId && !message.isMine && message.status === 'seen' && !message.call && (message.expiresAt === undefined || message.expiresAt > Date.now() / 1000))
    return { createdAtSecs: Math.floor(message.timestamp / 1000), ...(message.expiresAt !== undefined && { expiresAtSecs: message.expiresAt }) }
  const pending = (await db.sessionManager.get(readKey(owner, chatId, messageId)))?.value as MessageReadState | undefined
  return validMessageRead(pending) && (pending.expiresAtSecs === undefined || pending.expiresAtSecs > Date.now() / 1000) ? pending : undefined
}
export async function applyMessageRead(owner: string, chatId: string, messageId: string, read: MessageReadState, authorized: () => boolean): Promise<void> {
  if (!validMessageRead(read)) throw new Error('Invalid private read state')
  if (read.expiresAtSecs !== undefined && read.expiresAtSecs <= Date.now() / 1000) return
  const updated = await db.transaction('rw', db.messages, db.sessionManager, async () => {
    if (!authorized()) throw new Error('Account changed')
    const activeOwner = (await db.sessionManager.get('v1/device-manager/owner-pubkey'))?.value
    if (activeOwner && activeOwner !== owner) return false
    if (await db.sessionManager.get(`history-deleted-message:${messageId}`) || await isHistoryChatDeleted(chatId, read.createdAtSecs)) return
    const message = await db.messages.get(messageId)
    if (message) {
      if (message.sessionId === chatId && !message.isMine && !message.call && message.status !== 'seen' && Math.floor(message.timestamp / 1000) === read.createdAtSecs && (message.expiresAt === undefined || message.expiresAt > Date.now() / 1000)) {
        await db.messages.update(messageId, { status: 'seen' })
        return true
      }
    } else {
      const key = readKey(owner, chatId, messageId), old = (await db.sessionManager.get(key))?.value as MessageReadState | undefined
      // Match native's monotonic merge; preserve expiration learned before the original.
      if (!old || old.expiresAtSecs === undefined && read.expiresAtSecs !== undefined) {
        await db.sessionManager.put({ key, value: old ? { ...old, expiresAtSecs: read.expiresAtSecs } : read })
        return true
      }
    }
    return false
  })
  if (updated) changed(owner)
  // Also dismiss on replay; a browser enqueue may have raced the first read.
  if (authorized() && (await readState(owner,chatId,messageId))?.createdAtSecs === read.createdAtSecs)
    await dismissReadNotification({ownerPubkey:owner,chatId,messageId,createdAtSecs:read.createdAtSecs})
}
export async function projectMessageRead(owner: string, message: StoredMessage): Promise<StoredMessage> {
  if (message.isMine || message.call || message.status === 'seen') return message
  const read = await readState(owner, message.sessionId, message.id)
  return read?.createdAtSecs === Math.floor(message.timestamp / 1000) ? { ...message, status: 'seen' } : message
}
export async function projectSessionMessages(owner: string, sessionId: string, rows: StoredMessage[]): Promise<StoredMessage[]> {
  if (!rows.length) return rows
  const needsReadLookup = rows.some(row => !row.isMine && !row.call && row.status !== 'seen')
  const [intervalsByAuthor, readsByChat] = await Promise.all([
    loadBlockedIntervalsMap(owner),
    needsReadLookup ? loadPendingReadsMap(owner, sessionId) : Promise.resolve(new Map<string, Map<string, MessageReadState>>()),
  ])
  const pendingReads = readsByChat.get(sessionId)
  const filtered: StoredMessage[] = []
  for (const row of rows) {
    const createdSecs = Math.floor(row.timestamp / 1000)
    if (!row.isMine) {
      const author = row.senderPubkey ?? sessionId
      if (author !== owner && isTimestampBlocked(intervalsByAuthor.get(author), createdSecs)) continue
    }
    if (!row.isMine && !row.call && row.status !== 'seen' && pendingReads?.get(row.id)?.createdAtSecs === createdSecs) {
      filtered.push({ ...row, status: 'seen' })
    } else {
      filtered.push(row)
    }
  }
  return filtered
}
export async function* privateStateRecords(owner: string): AsyncGenerator<DeviceSyncRecord> {
  for await (const event of privateStateEvents(owner)) yield { type: event.kind === 10454 ? 'privateBlock' : 'privateNameApproval', event }
  let after = ''
  while (true) {
    const rows = await db.messages.where('id').above(after).limit(256).toArray()
    for (const message of rows) if (!message.isMine && message.status === 'seen' && !message.call && (message.expiresAt === undefined || message.expiresAt > Date.now() / 1000))
      yield { type: 'messageRead', chatId: message.sessionId, messageId: message.id, read: { createdAtSecs: Math.floor(message.timestamp / 1000), ...(message.expiresAt !== undefined && { expiresAtSecs: message.expiresAt }) } }
    if (rows.length < 256) break
    after = rows.at(-1)!.id
  }
  const prefix = `${base(owner)}read:`
  let cursor: string | undefined
  while (true) {
    const rows = await db.sessionManager.where('key').between(cursor ?? prefix, `${prefix}\uffff`, cursor === undefined, true).limit(256).toArray()
    for (const row of rows) {
      const [chatId, messageId] = JSON.parse(row.key.slice(prefix.length)), read = row.value
      if (!await db.messages.get(messageId) && validMessageRead(read) && (read.expiresAtSecs === undefined || read.expiresAtSecs > Date.now() / 1000)) yield { type: 'messageRead', chatId, messageId, read }
    }
    if (rows.length < 256) break
    cursor = rows.at(-1)!.key
  }
}

export async function restorePrivateBlocks(owner: string): Promise<void> {
  const heads = new Map<string, PrivateEvent>()
  for await (const event of privateStateEvents(owner)) if (event.kind === 10454) {
    const target = (privateEventState(event) as BlockState).target, previous = heads.get(target)
    if (!previous || comparePrivateEvents(event,previous) > 0) heads.set(target,event)
  }
  replaceBlockedContacts(owner,new Set([...heads].filter(([,event]) => (privateEventState(event) as BlockState).blocked).map(([target])=>target)))
}

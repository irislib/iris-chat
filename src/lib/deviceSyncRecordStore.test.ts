import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get, writable } from 'svelte/store'
import { finalizeEvent, getPublicKey, getEventHash } from 'nostr-tools'
import { db, deleteMessage, type StoredMessage } from './storage'
import { withDeviceControlClock, saveReactionHead, reactionHeads as iterReactions, saveGroupSettingsHead, groupSettingsHeads as iterSettings, saveSignedProfileHead, signedProfileHeads } from './deviceSyncRecordStore'
import { applyReactionRecord, applyGroupSettingsRecord, applyProfileRecord, persistMessageWithReactions, admitRecordMessage, restoreGroupSettings, captureReaction } from './deviceSyncRecordApply'
import { createDeviceSyncRecordAdapter, withLegacyReactions } from './deviceSyncRecordAdapter'
import { deviceSyncRecordId, type DeviceSyncGroupSettings, type DeviceSyncReaction } from './deviceSyncRecords'
import { deviceSyncPacketByteLength, DEVICE_SYNC_MAX_PACKET_BYTES, type DeviceSyncSnapshot } from './deviceSyncProtocol'

vi.mock('./chat', () => ({ chats: writable(new Map()), currentChat: writable(null) }))
vi.mock('./groups', () => ({ groups: writable(new Map()), groupMessages: writable(new Map()) }))
vi.mock('./profile', () => ({ addProfileToCache: vi.fn() }))
vi.mock('./nostrClient', () => ({ AppEvent: class { publish() { throw new Error('Private import must not publish') } } }))
import { chats, currentChat } from './chat'
import { groups, groupMessages } from './groups'
import { addProfileToCache } from './profile'
import { expirationStore } from './expirationStore'
async function reactionHeads(owner: string) { const records = []; for await (const head of iterReactions(owner)) records.push(head); return records }
async function groupSettingsHeads(owner: string) { const records = []; for await (const head of iterSettings(owner)) records.push(head); return records }
const owner = 'a'.repeat(64), peer = 'b'.repeat(64), outsider = 'c'.repeat(64)
const message: StoredMessage = { id: 'target', sessionId: peer, content: 'hello', timestamp: 100_000, isMine: true }
const reaction = (id: string, createdAt: number, emoji: string): DeviceSyncReaction => ({ chatId: peer, messageId: message.id, author: peer, id: id.repeat(64), createdAt, emoji })
const settings = (id: string, createdAt: number, ttl: number | null, author = owner): DeviceSyncGroupSettings => ({ groupId: 'friends', id: id.repeat(64), author, createdAt, messageTtlSeconds: ttl })

beforeEach(async () => {
  await db.messages.clear(); await db.sessionManager.clear(); vi.clearAllMocks(); expirationStore.clear()
  currentChat.set(null)
  chats.set(new Map([[peer, { id: peer, recipientPubkey: peer, messages: [], mode: 'manager' }]]))
  groups.set(new Map([['friends', { id: 'friends', name: 'Friends', members: [owner, peer], admins: [owner], createdAt: 1_000 }]]))
  groupMessages.set(new Map())
})

describe('durable private controls', () => {
  it('keeps a removal received before its message and rejects older adds after restart', async () => {
    expect(await applyReactionRecord(owner, reaction('b', 102, ''))).toBe(true)
    expect(await applyReactionRecord(owner, reaction('a', 101, '❤️'))).toBe(false)
    db.close(); await db.open()
    await persistMessageWithReactions(owner, { ...message, reactions: { '❤️': [peer] } })
    expect((await db.messages.get(message.id))?.reactions ?? {}).toEqual({})
    expect(await reactionHeads(owner)).toEqual([reaction('b', 102, '')])
    expect(await applyReactionRecord(owner, reaction('c', 103, '👍'))).toBe(true)
    expect((await db.messages.get(message.id))?.reactions).toEqual({ '👍': [peer] })
  })
  it('updates the visible conversation from the committed reaction head', async () => {
    await db.messages.put(message)
    const chat = { id: peer, recipientPubkey: peer, mode: 'manager' as const, messages: [{ id: message.id, content: message.content, timestamp: message.timestamp, isMine: true }] }
    chats.set(new Map([[peer, chat]])); currentChat.set(chat)
    await applyReactionRecord(owner, reaction('a', 101, '❤️'))
    expect(get(currentChat)?.messages[0].reactions).toEqual({ '❤️': [peer] })
    await applyReactionRecord(owner, reaction('b', 102, ''))
    expect(get(currentChat)?.messages[0].reactions).toEqual({})
  })
  it('only bootstraps legacy reactions into a new initial-history target, with durable heads winning', async () => {
    const legacy = [{ author: peer, emoji: '❤️' }], allowed = new Set([owner, peer])
    await admitRecordMessage(owner, message, legacy, false, allowed, () => true)
    expect((await db.messages.get(message.id))?.reactions ?? {}).toEqual({})
    await db.messages.clear()
    await admitRecordMessage(owner, message, legacy, true, allowed, () => true)
    expect((await db.messages.get(message.id))?.reactions).toEqual({ '❤️': [peer] })
    await admitRecordMessage(owner, message, [{ author: peer, emoji: '👍' }], true, allowed, () => true)
    expect((await db.messages.get(message.id))?.reactions).toEqual({ '❤️': [peer] })
    await db.messages.clear()
    await saveReactionHead(owner, reaction('f', 102, ''))
    await admitRecordMessage(owner, message, legacy, true, allowed, () => true)
    expect((await db.messages.get(message.id))?.reactions ?? {}).toEqual({})
  })
  it('captures the original authenticated control clock, including empty removal', async () => {
    const draft = { pubkey: peer, kind: 7, created_at: 100, tags: [['e', message.id], ['ms', '100123']], content: '' }
    const rumor = { ...draft, id: getEventHash(draft) }
    await captureReaction(owner, peer, rumor, peer, message.id, '')
    expect(await reactionHeads(owner)).toEqual([{ chatId: peer, messageId: message.id, author: peer, id: rumor.id, createdAt: 100, createdAtMs: 100123, emoji: '' }])
  })
  it('preserves rapid local reaction and settings intent when the wall clock does not advance', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    try {
      const key = { chatId: peer, messageId: message.id, author: peer }
      await Promise.all(['❤️', '', '👍'].map((emoji, index) => withDeviceControlClock(owner, key, async nowMs => {
        await applyReactionRecord(owner, { ...reaction(String(index + 1), Math.floor(nowMs / 1000), emoji), createdAtMs: nowMs })
      })))
      expect((await reactionHeads(owner))[0]).toMatchObject({ emoji: '👍', createdAtMs: 100_002 })
      await Promise.all([60, null, 3600].map((ttl, index) => withDeviceControlClock(owner, 'friends', async nowMs => {
        await applyGroupSettingsRecord(owner, { ...settings(String(index + 1), Math.floor(nowMs / 1000), ttl), createdAtMs: nowMs })
      })))
      expect((await groupSettingsHeads(owner))[0]).toMatchObject({ messageTtlSeconds: 3600, createdAtMs: 100_002 })
      expect(expirationStore.getExpiration('friends')).toBe(3600)
    } finally { now.mockRestore() }
  })
  it('recovers committed settings after a shutdown before preference projection', async () => {
    await saveGroupSettingsHead(owner, settings('b', 103, null))
    expirationStore.setExpiration('friends', 3600)
    await restoreGroupSettings(owner, 'friends')
    expect(expirationStore.getExpiration('friends')).toBe(null)
  })
  it('preserves deletion suppression and checks actor and live authorization', async () => {
    await db.messages.put(message); await deleteMessage(message.id)
    expect(await applyReactionRecord(owner, reaction('b', 102, '❤️'))).toBe(false)
    expect(await applyReactionRecord(owner, { ...reaction('b', 102, '❤️'), author: outsider })).toBe(false)
    expect(await saveReactionHead(owner, reaction('b', 102, ''), () => false)).toBe(false)
    expect(await reactionHeads(owner)).toEqual([])
  })
  it('applies newer authorized settings locally, including off, without regressing', async () => {
    expirationStore.setExpiration('friends', 3600)
    expect(await applyGroupSettingsRecord(owner, settings('b', 103, null))).toBe(true)
    expect(await applyGroupSettingsRecord(owner, settings('c', 102, 60))).toBe(false)
    expect(await applyGroupSettingsRecord(owner, settings('d', 104, 60, peer))).toBe(false)
    expect(await applyGroupSettingsRecord(owner, settings('e', 105, 60), () => false)).toBe(false)
    expect(expirationStore.getExpiration('friends')).toBe(null)
    expect(await groupSettingsHeads(owner)).toEqual([settings('b', 103, null)])
  })
  it('keeps original signed contact profiles and rejects stale, forged and unrelated events', async () => {
    const secret = new Uint8Array(32).fill(1), pubkey = getPublicKey(secret), contacts = new Set([pubkey])
    const event = finalizeEvent({ kind: 0, created_at: 100, tags: [], content: '{"name":"Alice"}' }, secret)
    expect(await applyProfileRecord(owner, event, contacts)).toBe(true)
    expect(await applyProfileRecord(owner, finalizeEvent({ kind: 0, created_at: 99, tags: [], content: '{"name":"Old"}' }, secret), contacts)).toBe(false)
    expect(await applyProfileRecord(owner, { ...event, content: '{"name":"Forged"}' }, contacts)).toBe(false)
    expect(await applyProfileRecord(owner, event, new Set())).toBe(false)
    expect(await signedProfileHeads(owner, contacts)).toEqual([JSON.parse(JSON.stringify(event))])
    expect(await signedProfileHeads(owner, new Set([outsider]))).toEqual([])
    expect(addProfileToCache).toHaveBeenCalledTimes(1)
  })
  it('uses the same timestamp lower-ID profile winner regardless of delivery order', async () => {
    const secret = new Uint8Array(32).fill(2)
    const events = ['One', 'Two'].map(name => finalizeEvent({ kind: 0, created_at: 100, tags: [], content: JSON.stringify({ name }) }, secret)).sort((a, b) => a.id < b.id ? -1 : 1)
    await saveSignedProfileHead(owner, events[1]); await saveSignedProfileHead(owner, events[0]); await saveSignedProfileHead(owner, events[1])
    expect((await signedProfileHeads(owner, new Set([events[0].pubkey])))[0].id).toBe(events[0].id)
  })
  it('rechecks membership, expiry and current heads before serving stored locators', async () => {
    const group = { id: 'friends', name: 'Friends', createdBy: owner, members: [owner, peer], admins: [owner], revision: 1, createdAt: 1, updatedAt: 2 }
    const wire = { chatId: 'group:friends', id: message.id, body: 'Hello', author: owner, createdAt: 100 }
    await db.messages.put({ ...message, sessionId: wire.chatId })
    await saveReactionHead(owner, { ...reaction('a', 101, '❤️'), chatId: wire.chatId })
    await saveGroupSettingsHead(owner, settings('b', 102, 60))
    const packet: DeviceSyncSnapshot = { v: 1, type: 'snapshot', rosterAt: 0, appKeys: [], chats: [], groups: [group], messages: [] }
    const adapter = createDeviceSyncRecordAdapter({ owner, snapshots: () => [packet], messages: () => [wire], allowsLegacy: () => false, applySnapshot: async () => 0 })
    const refs = await adapter.recordInventory('history', 0, 200, false)
    expect((await adapter.records('history', 0, 200, refs, 'peer')).length).toBe(2)
    group.members = [peer]
    expect(await adapter.records('history', 0, 200, refs, 'peer')).toEqual([])
    group.members = [owner, peer]
    await db.messages.update(message.id, { expiresAt: 1 })
    expect(await adapter.records('history', 0, 200, refs, 'peer')).toEqual([])
    const stateRefs = await adapter.recordInventory('state', 0, 0, false)
    await saveGroupSettingsHead(owner, settings('c', 103, null))
    expect((await adapter.records('state', 0, 0, stateRefs, 'peer')).map(record => record.type)).toEqual(['group'])
  })
  it('bounds optional legacy projection without withholding the message itself', async () => {
    const authors = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(64, '0'))
    await db.messages.put({ ...message, content: 'x'.repeat(44_000), reactions: { '❤️': authors } })
    const enriched = await withLegacyReactions({ chatId: peer, id: message.id, body: 'x'.repeat(44_000), author: owner, createdAt: 100 })
    expect(enriched.body.length).toBe(44_000)
    expect(enriched.legacyReactions!.length).toBeGreaterThan(0)
    expect(enriched.legacyReactions!.length).toBeLessThan(256)
    expect(deviceSyncPacketByteLength({ v: 1, type: 'historyRecords', session: '0'.repeat(32), records: [{ type: 'message', message: enriched }], requested: [] })).toBeLessThanOrEqual(DEVICE_SYNC_MAX_PACKET_BYTES)
  })
  it('enumerates durable heads in batches without a lifetime account cap', async () => {
    await db.sessionManager.bulkPut(Array.from({ length: 601 }, (_, index) => {
      const value = { ...reaction('a', 101, '❤️'), messageId: `target-${index}` }
      return { key: `device-record-v1:${owner}:reaction:${JSON.stringify([peer, value.messageId, peer])}`, value }
    }))
    expect((await reactionHeads(owner)).length).toBe(601)
    expect(await saveReactionHead(owner, reaction('b', 102, ''))).toBe(true)
    expect((await reactionHeads(owner)).length).toBe(602)
  })
  it('exports current state for actual contacts only and excludes old history with opt-out', async () => {
    const secret = new Uint8Array(32).fill(3), pubkey = getPublicKey(secret)
    const event = finalizeEvent({ kind: 0, created_at: 50, tags: [], content: '{"name":"Contact"}' }, secret)
    await saveSignedProfileHead(owner, event)
    await saveGroupSettingsHead(owner, settings('c', 50, 60))
    await saveReactionHead(owner, reaction('d', 50, '❤️'))
    const packet: DeviceSyncSnapshot = { v: 1, type: 'snapshot', rosterAt: 100, appKeys: [], chats: [{ id: peer, updatedAt: 0 }], groups: [], messages: [] }
    const adapter = createDeviceSyncRecordAdapter({ owner, snapshots: () => [packet], messages: () => [], allowsLegacy: () => false, applySnapshot: vi.fn(async () => 0) })
    expect(await adapter.recordInventory('history', 100, 200, false)).toEqual([])
    expect(await adapter.recordInventory('state', 0, 0, false)).toEqual([])
    packet.chats.push({ id: pubkey, updatedAt: 0 })
    const inventory = await adapter.recordInventory('state', 0, 0, false)
    expect(inventory).toEqual([expect.objectContaining({ id: deviceSyncRecordId({ type: 'profile', event }), createdAt: 0 })])
    await db.sessionManager.put({ key: `history-deleted-chat:${pubkey}`, value: 101 })
    expect(await adapter.recordInventory('state', 0, 0, false)).toEqual([])
  })
})

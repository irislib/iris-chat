import 'fake-indexeddb/auto'
import { beforeEach, expect, it, vi } from 'vitest'
import { writable } from 'svelte/store'
import { db, type StoredMessage } from './storage'
import { applyMessageMutation } from './messageMutations'
import { createDeviceSyncRecordAdapter } from './deviceSyncRecordAdapter'
import { deviceSyncRecordId, deviceSyncRecordTime, type DeviceSyncMessageMutation, type DeviceSyncRecord } from './deviceSyncRecords'
import { DeviceHistorySync } from './deviceHistorySync'
import { encodeDeviceSyncPacket, parseDeviceSyncPacket, type DeviceHistoryPacket, type DeviceSyncMessage } from './deviceSyncProtocol'
import { messageMutationRecords } from './messageMutations'
import { messageDeletionSettings } from './messageDeletionSettings'

vi.mock('./chat', () => ({ chats: writable(new Map()), currentChat: writable(null) }))
vi.mock('./groups', () => ({ groups: writable(new Map()), groupMessages: writable(new Map()) }))
const owner = 'a'.repeat(64), peer = 'b'.repeat(64), id = 'c'.repeat(64)
const original: StoredMessage = { id, sessionId: peer, content: 'Private original', timestamp: 100_000, isMine: false, senderPubkey: peer }
const mutation: DeviceSyncMessageMutation = { chatId: peer, id: 'd'.repeat(64), messageId: id, author: peer,
  createdAt: 120, operation: 'edit', content: 'Private correction' }
function adapter(messages: DeviceSyncMessage[] = [], mutationTargetSince?: (peer: string) => number) {
  return createDeviceSyncRecordAdapter({ owner,
    snapshots: () => [{ v: 1, type: 'snapshot', rosterAt: 0, appKeys: [], chats: [{ id: peer, updatedAt: 0 }], groups: [], messages: [] }],
    messages: () => messages, allowsLegacy: () => false, mutationTargetSince, applySnapshot: async (packet, since) => {
      let imported = 0
      for (const message of packet.messages) {
        if (message.createdAt < (since ?? 0)) continue
        if (!await db.messages.get(message.id)) imported++
        await db.messages.put({ id: message.id, sessionId: message.chatId, content: message.body, timestamp: message.createdAt * 1000, isMine: false, senderPubkey: message.author })
        if (!messages.some(row => row.id === message.id)) messages.push(message)
      }
      return imported
    } })
}
beforeEach(async () => {
  await db.messages.clear(); await db.sessionManager.clear()
  messageDeletionSettings.set({ allowDeletionByOthers: true })
})
it('never exports a later edit of pre-link history to a chats-only sibling', async () => {
  await db.messages.put(original)
  await applyMessageMutation(owner, mutation)
  const source = adapter()
  const full = await source.recordInventory('history', 0, 150, false)
  expect(full).toHaveLength(1)
  expect(await source.recordInventory('history', 110, 150, false)).toEqual([])
  // A stale inventory must not bypass the narrower authorized window.
  expect(await source.records('history', 110, 150, full, 'sibling')).toEqual([])
  expect(await source.records('history', 0, 150, full, 'linking-device', 'private-link')).toEqual([{ type: 'messageMutation', mutation }])
})
it('exports no deferred mutation until the matching original establishes history entitlement', async () => {
  await applyMessageMutation(owner, mutation)
  const source = adapter()
  expect(await source.recordInventory('history', 0, 150, false)).toEqual([])
  await db.messages.put({ ...original, timestamp: 110_000 })
  const entitled = await source.recordInventory('history', 110, 150, false)
  expect(entitled.map(ref => ref.id)).toEqual([deviceSyncRecordId({ type: 'messageMutation', mutation })])
  await db.messages.put({ ...original, sessionId: 'e'.repeat(64) })
  expect(await source.records('history', 0, 150, entitled, 'sibling')).toEqual([])
})
it('rechecks author, expiry and the original upper bound when serving a mutation', async () => {
  await db.messages.put(original)
  await applyMessageMutation(owner, mutation)
  const source = adapter(), refs = await source.recordInventory('history', 0, 150, false)
  for (const changed of [{ ...original, senderPubkey: owner }, { ...original, expiresAt: 1 }, { ...original, timestamp: 151_000 }]) {
    await db.messages.put(changed)
    expect(await source.records('history', 0, 150, refs, 'sibling')).toEqual([])
  }
})
it('retains old-target entitlement only for the approved history pair after backfill completes', async () => {
  await db.messages.put(original)
  await applyMessageMutation(owner, mutation)
  let approved = true
  const source = adapter([], device => device === 'approved-pair' && approved ? 0 : 110)
  const full = await source.recordInventory('history', 110, 150, false, '', 'approved-pair')
  expect(full).toHaveLength(1)
  expect(await source.recordInventory('history', 110, 150, false, '', 'other-sibling')).toEqual([])
  expect(await source.records('history', 110, 150, full, 'approved-pair')).toHaveLength(1)
  expect(await source.records('history', 110, 150, full, 'other-sibling')).toEqual([])
  approved = false
  expect(await source.records('history', 110, 150, full, 'approved-pair')).toEqual([])
})
it('imports originals before controls and never stores unknown or pre-floor edit text', async () => {
  const receiver = adapter(), record = { type: 'messageMutation' as const, mutation }
  const apply = (records: DeviceSyncRecord[], since = 110) => receiver.applyRecords('sibling', records, 'history', since, 150, undefined, () => true)
  expect(await apply([record])).toMatchObject({ deferred: [deviceSyncRecordId(record)] })
  expect(await Array.fromAsync(messageMutationRecords(owner))).toEqual([])
  await db.messages.put(original)
  expect(await apply([record])).toMatchObject({ deferred: [] })
  expect(await Array.fromAsync(messageMutationRecords(owner))).toEqual([])
  await db.messages.clear()
  const message: DeviceSyncMessage = { chatId: peer, id, body: original.content, author: peer, createdAt: 110 }
  expect(await apply([record, { type: 'message', message }])).toEqual({ imported: 1, deferred: [] })
  expect((await db.messages.get(id))?.content).toBe(mutation.content)
})
it.each([false, true])('retries controls after an original in a later partition, with no premature success (missing original: %s)', async (missing: boolean) => {
  const message: DeviceSyncRecord = { type: 'message', message: { chatId: peer, id, body: original.content, author: peer, createdAt: 110 } }
  let control: DeviceSyncRecord = { type: 'messageMutation', mutation }
  // Force the control into an earlier hash partition than its original.
  for (let value = 0; deviceSyncRecordId(control) >= deviceSyncRecordId(message); value++) {
    control = { type: 'messageMutation', mutation: { ...mutation, id: value.toString(16).padStart(64, '0') } }
  }
  const records = missing ? [control] : [control, message], queue: Array<{ to: number; packet: DeviceHistoryPacket }> = []
  const completed = vi.fn(), waiting = vi.fn(), deferred = vi.fn(), receiver = adapter()
  const send = (to: number) => async (_peer: string, packet: DeviceHistoryPacket) => {
    queue.push({ to, packet: parseDeviceSyncPacket(encodeDeviceSyncPacket(packet), owner) as DeviceHistoryPacket })
  }
  const common = { authorized: () => true, now: () => 200_000, maxInventoryRecords: 1 }
  const first = new DeviceHistorySync({ ...common, ...receiver, send: send(1), complete: completed, unavailable: waiting,
    applyRecords: async (...args) => {
      const result = await receiver.applyRecords(...args)
      if (result.deferred.length) {
        deferred()
        expect(await Array.fromAsync(messageMutationRecords(owner))).toEqual([])
        expect(completed).not.toHaveBeenCalled()
      }
      return result
    } })
  const second = new DeviceHistorySync({ ...common, send: send(0),
    recordInventory: async (_scope, _since, _until, _initiator, prefix) => records.filter(record => deviceSyncRecordId(record).startsWith(prefix)).map(record => ({
      id: deviceSyncRecordId(record), createdAt: deviceSyncRecordTime(record), locator: { type: record.type, key: [] } })),
    records: async (_scope, _since, _until, refs) => records.filter(record => refs.some(ref => ref.id === deviceSyncRecordId(record))),
    applyRecords: async () => 0 })
  first.negotiate('second', 110); second.negotiate('first', 110)
  await first.start('second', 110, 150)
  let count = 0
  while (queue.length) {
    expect(++count).toBeLessThan(300)
    const { to, packet } = queue.shift()!
    await [first, second][to].receive(to ? 'first' : 'second', packet)
  }
  expect(deferred).toHaveBeenCalled()
  if (missing) {
    expect(completed).not.toHaveBeenCalled(); expect(waiting).toHaveBeenCalledTimes(1)
    expect(await Array.fromAsync(messageMutationRecords(owner))).toEqual([])
  } else {
    expect(completed).toHaveBeenCalledTimes(1); expect(waiting).not.toHaveBeenCalled()
    expect((await db.messages.get(id))?.content).toBe(mutation.content)
  }
})

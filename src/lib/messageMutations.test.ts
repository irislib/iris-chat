import 'fake-indexeddb/auto'
import { beforeEach, expect, it, vi } from 'vitest'
import { get, writable } from 'svelte/store'
import { getEventHash } from 'nostr-tools'
import { db, deleteMessage, deleteMessagesForSession, purgeExpiredMessageMutations, type StoredMessage } from './storage'
import { applyMessageMutation, buildMessageMutation, captureMessageMutation, messageMutationRecords, mutationFromRumor } from './messageMutations'
import { persistMessageWithReactions, admitRecordMessage } from './deviceSyncRecordApply'
import { messageDeletionSettings } from './messageDeletionSettings'
import { deviceSyncRecordId, deviceSyncRecordScope, deviceSyncRecordTime } from './deviceSyncRecords'
import { parseDeviceSyncPacket, encodeDeviceSyncPacket } from './deviceSyncProtocol'
import { createDeviceSyncRecordAdapter } from './deviceSyncRecordAdapter'

vi.mock('./chat', () => ({ chats: writable(new Map()), currentChat: writable(null) }))
vi.mock('./groups', () => ({ groups: writable(new Map()), groupMessages: writable(new Map()) }))
import { chats, currentChat } from './chat'
import { groups, groupMessages } from './groups'
const owner = 'a'.repeat(64), peer = 'b'.repeat(64), outsider = 'c'.repeat(64), id = 'd'.repeat(64)
const original: StoredMessage = { id, sessionId: peer, content: 'Original text', timestamp: 100_000, isMine: false, senderPubkey: peer }
const mutation = (operation: 'edit' | 'delete', content: string, nowMs = 101_000, author = peer, chatId = peer) =>
  mutationFromRumor(chatId, buildMessageMutation(author, id, operation, content, ['p', owner], nowMs), author)!
async function records() { const result = []; for await (const value of messageMutationRecords(owner)) result.push(value); return result }
async function seed(message = original) {
  await db.messages.put(message)
  const chat = { id: peer, recipientPubkey: peer, mode: 'manager' as const, messages: [message] }
  chats.set(new Map([[peer, chat]])); currentChat.set(chat)
}
beforeEach(async () => {
  await db.messages.clear(); await db.sessionManager.clear()
  messageDeletionSettings.set({ allowDeletionByOthers: true })
  chats.set(new Map()); currentChat.set(null); groupMessages.set(new Map())
  groups.set(new Map([['friends', { id: 'friends', name: 'Friends', members: [owner, peer, outsider], admins: [owner], createdAt: 1 }]]))
})
it('preserves the original and every edit, deduplicates and converges after shuffled delivery and reload', async () => {
  const first = mutation('edit', 'First correction', 101_010), last = mutation('edit', 'Final correction', 101_012)
  await applyMessageMutation(owner, last)
  await applyMessageMutation(owner, first)
  db.close(); await db.open()
  await seed()
  await persistMessageWithReactions(owner, original)
  expect(await applyMessageMutation(owner, last)).toBe(false)
  expect(await db.messages.get(id)).toMatchObject({ id, timestamp: 100_000, content: 'Final correction', originalContent: 'Original text', editedAt: 101_012,
    editHistory: [{ id, content: 'Original text' }, { id: first.id, content: 'First correction' }, { id: last.id, content: 'Final correction' }] })
  expect(get(currentChat)?.messages[0].content).toBe('Final correction')
  // A duplicate original cannot overwrite the projection.
  await persistMessageWithReactions(owner, original)
  expect((await db.messages.get(id))?.content).toBe('Final correction')
})
it('deletes content and prior edit records permanently, including late edits and original replay', async () => {
  await seed({ ...original, reactions: { '👍': [owner] }, replyTo: 'reply' })
  await applyMessageMutation(owner, mutation('edit', 'Changed text'))
  const deletion = mutation('delete', '', 102_000)
  expect(await applyMessageMutation(owner, deletion)).toBe(true)
  expect(await db.messages.get(id)).toMatchObject({ content: '', deletedAt: 102_000 })
  expect((await db.messages.get(id))?.editHistory).toBeUndefined()
  expect((await db.messages.get(id))?.reactions).toBeUndefined()
  expect(await records()).toEqual([deletion])
  expect(await applyMessageMutation(owner, mutation('edit', 'Resurrect', 103_000))).toBe(false)
  await persistMessageWithReactions(owner, { ...original, reactions: { '👍': [peer] }, replyTo: 'old' })
  expect((await db.messages.get(id))?.reactions).toBeUndefined()
  expect((await db.messages.get(id))?.replyTo).toBeUndefined()
  expect((await db.messages.get(id))?.content).toBe('')
  expect(get(currentChat)?.messages[0].deletedAt).toBe(102_000)
})
it('handles deletion before the original and retains local-only deletion suppression', async () => {
  await applyMessageMutation(owner, mutation('edit', 'Old content'))
  await applyMessageMutation(owner, mutation('delete', '', 102_000))
  const stored = await admitRecordMessage(owner, original, undefined, false, new Set([owner, peer]), () => true)
  expect(stored).toMatchObject({ content: '', deletedAt: 102_000 })
  expect(await records()).toHaveLength(1)
  await deleteMessage(id)
  expect(await records()).toEqual([])
  expect(await applyMessageMutation(owner, mutation('edit', 'Another', 103_000))).toBe(false)
  expect(await admitRecordMessage(owner, original, undefined, false, new Set([owner, peer]), () => true)).toBeUndefined()
})
it('requires the original author and conversation; claimed pubkey cannot authorize a control', async () => {
  await seed()
  expect(await applyMessageMutation(owner, mutation('delete', '', 102_000, owner))).toBe(false)
  expect(await applyMessageMutation(owner, mutation('delete', '', 102_000, outsider))).toBe(false)
  expect(await applyMessageMutation(owner, mutation('delete', '', 102_000, peer, 'group:friends'))).toBe(false)
  const claimed = buildMessageMutation(peer, id, 'delete', '', ['p', owner], 102_000)
  expect(await captureMessageMutation(owner, peer, claimed, owner)).toBe(false)
  expect((await db.messages.get(id))?.content).toBe(original.content)
  expect(await records()).toEqual([])
})
it('rejects group admin edits/deletion of another person’s message', async () => {
  const groupMessage = { ...original, sessionId: 'group:friends' }
  await seed(groupMessage)
  groupMessages.set(new Map([['friends', [groupMessage]]]))
  expect(await applyMessageMutation(owner, mutation('delete', '', 102_000, owner, 'group:friends'))).toBe(false)
  expect(await applyMessageMutation(owner, mutation('edit', 'By sender', 101_000, peer, 'group:friends'))).toBe(true)
  expect(get(groupMessages).get('friends')?.[0].content).toBe('By sender')
})
it('opt-out ignores other senders’ deletes but honors own deletes and does not undo previous deletion', async () => {
  await seed(); messageDeletionSettings.set({ allowDeletionByOthers: false })
  expect(await applyMessageMutation(owner, mutation('delete', ''))).toBe(false)
  expect(await applyMessageMutation(owner, mutation('edit', 'Still editable'))).toBe(true)
  expect((await db.messages.get(id))?.content).toBe('Still editable')
  await seed({ ...original, isMine: true, senderPubkey: owner })
  expect(await applyMessageMutation(owner, mutation('delete', '', 102_000, owner))).toBe(true)
  messageDeletionSettings.set({ allowDeletionByOthers: true })
  await persistMessageWithReactions(owner, { ...original, isMine: true, senderPubkey: owner })
  expect((await db.messages.get(id))?.deletedAt).toBe(102_000)
})
it('rejects malformed wire controls, empty or oversized edits, attachment edits and expired targets', async () => {
  const good = buildMessageMutation(peer, id, 'edit', 'new', ['p', owner], 102_000)
  expect(() => buildMessageMutation(peer, id, 'edit', ' ', ['p', owner])).toThrow()
  expect(() => buildMessageMutation(peer, id, 'edit', '🦊'.repeat(9000), ['p', owner])).toThrow()
  for (const tags of [good.tags.filter(tag => tag[0] !== 'k'), [...good.tags, ['e', 'e'.repeat(64)]], good.tags.map(tag => tag[0] === 'k' ? ['k', '7'] : tag)]) {
    const bad = { ...good, tags }; bad.id = getEventHash(bad)
    expect(mutationFromRumor(peer, bad, peer)).toBeUndefined()
  }
  for (const body of ['iris-direct-file-v1:payload', 'htree://nhash1abc/file.jpg', '![photo](https://example.com/image.jpg)']) {
    await seed({ ...original, content: body })
    expect(await applyMessageMutation(owner, mutation('edit', 'replacement'))).toBe(false)
  }
  await seed({ ...original, expiresAt: 1 })
  expect(await applyMessageMutation(owner, mutation('delete', ''))).toBe(false)
})
it('roundtrips mutation records through the shared history wire and serves immutable original text', async () => {
  await seed()
  const edit = mutation('edit', 'corrected')
  await applyMessageMutation(owner, edit)
  const record = { type: 'messageMutation' as const, mutation: edit }
  const packet = { v: 1 as const, type: 'historyRecords' as const, session: '0'.repeat(32), records: [record], requested: [] }
  expect(parseDeviceSyncPacket(encodeDeviceSyncPacket(packet), owner)).toEqual(packet)
  expect(deviceSyncRecordScope(record)).toBe('history'); expect(deviceSyncRecordTime(record)).toBe(101)
  const adapter = createDeviceSyncRecordAdapter({ owner, snapshots: () => [{ v: 1, type: 'snapshot', rosterAt: 0, appKeys: [], chats: [{ id: peer, updatedAt: 0 }], groups: [], messages: [] }],
    messages: () => [{ chatId: peer, id, body: original.content, author: peer, createdAt: 100 }], allowsLegacy: () => false, applySnapshot: async () => 0 })
  const inventory = await adapter.recordInventory('history', 0, 200, false)
  expect(inventory.some(ref => ref.id === deviceSyncRecordId(record))).toBe(true)
  const exported = await adapter.records('history', 0, 200, inventory, 'device')
  expect(exported.find(record => record.type === 'message')).toMatchObject({ message: { body: original.content } })
  expect(exported).toContainEqual(record)
  await db.messages.clear(); await db.sessionManager.clear()
  await adapter.applyRecords('device', [record], 'history', 0, 200, undefined, () => true)
  await persistMessageWithReactions(owner, original)
  expect((await db.messages.get(id))?.content).toBe('corrected')
})


it('purges pending edit text when its chat is removed or its original expiry passes', async () => {
  await applyMessageMutation(owner, mutation('edit', 'pending private text'))
  await deleteMessagesForSession(peer)
  expect(await records()).toEqual([])
  await db.sessionManager.clear()
  const future = Math.floor(Date.now() / 1000) + 60
  const expiring = { ...mutation('edit', 'expiring pending text'), expiresAt: future }
  await applyMessageMutation(owner, expiring)
  await purgeExpiredMessageMutations(future)
  expect(await records()).toEqual([])
  expect(await applyMessageMutation(owner, { ...expiring, expiresAt: 1 })).toBe(false)
})

it('ignores pre-original controls and rejects ambiguous or malformed millisecond clocks', async () => {
  const stale = mutation('delete', '', 99000)
  await applyMessageMutation(owner, stale)
  await persistMessageWithReactions(owner, original)
  expect((await db.messages.get(id))?.content).toBe(original.content)
  expect(await applyMessageMutation(owner, mutation('edit', 'too early', 98000))).toBe(false)
  for (const msTags of [[['ms', 'bad']], [['ms', '100000']], [['ms', '101000'], ['ms', '101000']]]) {
    const rumor = buildMessageMutation(peer, id, 'edit', 'text', ['p', owner], 101000)
    rumor.tags = [...rumor.tags.filter(tag => tag[0] !== 'ms'), ...msTags]
    rumor.id = getEventHash(rumor)
    expect(mutationFromRumor(peer, rumor, peer)).toBeUndefined()
  }
})
it('never exposes an original when a pending tombstone cannot be committed', async () => {
  await applyMessageMutation(owner, mutation('delete', ''))
  const failure = vi.spyOn(db.messages, 'put').mockRejectedValueOnce(new Error('Storage unavailable'))
  await expect(persistMessageWithReactions(owner, original)).rejects.toThrow('Storage unavailable')
  failure.mockRestore()
  expect(await db.messages.get(id)).toBeUndefined()
  expect(await records()).toHaveLength(1)
  expect(await persistMessageWithReactions(owner, original)).toMatchObject({ content: '', deletedAt: 101000 })
})

import 'fake-indexeddb/auto'
import { beforeEach, expect, it } from 'vitest'
import { db } from './storage'
import { DexieStorageAdapter } from './sessionManagerStorage'
const owner = 'a'.repeat(64), sibling = 'b'.repeat(64), peer = 'c'.repeat(64)
beforeEach(async () => { await db.sessionManager.clear() })
it('removes legacy queued own mutations before discovery while preserving participant delivery and ordinary messages', async () => {
  const storage = new DexieStorageAdapter(owner)
  await db.sessionManager.put({ key: `v1/user/${owner}`, value: { devices: [{ deviceId: sibling }] } })
  for (const [prefix, target, kind, keep] of [
    ['discovery-queue', owner, 1009, false], ['discovery-queue', owner, 5, false],
    ['message-queue', sibling, 1009, false], ['message-queue', peer, 1009, true],
    ['discovery-queue', peer, 1009, true], ['discovery-queue', owner, 14, true],
  ] as const) {
    const event = { id: 'd'.repeat(64), pubkey: owner, kind, content: 'Queued content' }
    const key = `v1/${prefix}/${event.id}/${target}`, row = { id: `${event.id}/${target}`, targetKey: target, event, createdAt: 1 }
    await db.sessionManager.put({ key, value: row })
    expect(!!await storage.get(key)).toBe(keep)
    expect(!!await db.sessionManager.get(key)).toBe(keep)
    await storage.put(key, row)
    expect(!!await db.sessionManager.get(key)).toBe(keep)
  }
})
it('does not journal own live mutation plaintext and cleans legacy pending inboxes without dropping participant controls', async () => {
  const storage = new DexieStorageAdapter(owner), key = `v1/user/${owner}`
  const entry = (sender: string, kind: number) => ({ id: `${sender}:${kind}`, sender, meta: { senderOwnerPubkey: sender }, event: { kind, content: 'Original control' } })
  const keep = [entry(owner, 10449), entry(peer, 1009)]
  const row = { publicKey: owner, devices: [{ deviceId: sibling }], pendingDurableEvents: [...keep, entry(owner, 1009), entry(owner, 5)] }
  await storage.put(key, row)
  expect((await db.sessionManager.get(key))?.value).toEqual({ ...row, pendingDurableEvents: keep })
  await db.sessionManager.put({ key, value: row })
  expect(await storage.get(key)).toEqual({ ...row, pendingDurableEvents: keep })
  expect((await db.sessionManager.get(key))?.value).toEqual({ ...row, pendingDurableEvents: keep })
  expect(row.pendingDurableEvents).toHaveLength(4)
})
it('preserves queued participant data when owner context is missing or belongs to another account', async () => {
  const event = { id: 'e'.repeat(64), pubkey: owner, kind: 1009, content: 'Pending participant correction' }
  const key = `v1/discovery-queue/${event.id}/${owner}`, row = { targetKey: owner, event }
  await db.sessionManager.put({ key, value: row })
  expect(await new DexieStorageAdapter().get(key)).toEqual(row)
  expect(await new DexieStorageAdapter(peer).get(key)).toEqual(row)
  const closed = new DexieStorageAdapter(owner); closed.close()
  expect(await closed.get(key)).toBeUndefined()
  expect((await db.sessionManager.get(key))?.value).toEqual(row)
})

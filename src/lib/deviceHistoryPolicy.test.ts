import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { closeRevokedDeviceHistoryPairs, deviceHistoryPair, loadDeviceHistoryPairs, saveDeviceHistoryPair } from './deviceHistoryPolicy'
import { isHistoryMessageSettled, admitHistoryMessage, db, deleteMessage, deletedHistoryRecords, deleteMessagesForSession, saveMessage, type StoredMessage } from './storage'

const secret = generateSecretKey(), owner = getPublicKey(secret), device = 'a'.repeat(64)
const stored: StoredMessage = { id: 'example', sessionId: device, content: 'hello', timestamp: 100_000, isMine: true }
beforeEach(async () => { await db.messages.clear(); await db.sessionManager.clear(); await loadDeviceHistoryPairs(owner, device) })

describe('private pair history scope', () => {
  it('persists only this approving pair and never reopens a completed link operation', async () => {
    const peer = 'b'.repeat(64), linkId = 'c'.repeat(64)
    const pair = { peer, linkId, linkAt: 100, since: 0, role: 'outbound' as const, complete: false }
    await saveDeviceHistoryPair(owner, device, pair)
    await loadDeviceHistoryPairs(owner, device)
    expect(deviceHistoryPair(owner, device, peer)).toEqual(pair)
    expect(deviceHistoryPair(owner, peer, device)).toBeUndefined()
    expect(deviceHistoryPair('f'.repeat(64), device, peer)).toBeUndefined()
    await saveDeviceHistoryPair(owner, device, { ...pair, complete: true })
    await saveDeviceHistoryPair(owner, device, pair)
    expect(deviceHistoryPair(owner, device, peer)?.complete).toBe(true)
    await saveDeviceHistoryPair(owner, device, { ...pair, linkId: 'd'.repeat(64), since: 100, complete: true })
    await loadDeviceHistoryPairs(owner, device)
    expect(deviceHistoryPair(owner, device, peer)?.since).toBe(100)
  })
  it('closes an observed revoked link before a same-second relink can reuse its permission', async () => {
    const peer = 'b'.repeat(64), linkId = 'c'.repeat(64)
    await saveDeviceHistoryPair(owner, device, { peer, linkId, linkAt: 100, since: 0, role: 'outbound', complete: false })
    await closeRevokedDeviceHistoryPairs(owner, device, [device, peer])
    await closeRevokedDeviceHistoryPairs(owner, device, [device])
    await loadDeviceHistoryPairs(owner, device)
    expect(deviceHistoryPair(owner, device, peer)?.complete).toBe(true)
    await saveDeviceHistoryPair(owner, device, { peer, linkId, linkAt: 100, since: 0, role: 'outbound', complete: false })
    expect(deviceHistoryPair(owner, device, peer)?.complete).toBe(true)
    await saveDeviceHistoryPair(owner, device, { peer, linkId: 'd'.repeat(64), linkAt: 100, since: 0, role: 'outbound', complete: false })
    expect(deviceHistoryPair(owner, device, peer)?.complete).toBe(false)
  })
  it('revokes retained mutation entitlement even after initial history completed', async () => {
    const peer = 'b'.repeat(64), linkId = 'c'.repeat(64)
    const pair = { peer, linkId, linkAt: 100, since: 0, role: 'outbound' as const, complete: true, authorized: true }
    await saveDeviceHistoryPair(owner, device, pair)
    await closeRevokedDeviceHistoryPairs(owner, device, [device])
    await closeRevokedDeviceHistoryPairs(owner, device, [device, peer])
    await loadDeviceHistoryPairs(owner, device)
    expect(deviceHistoryPair(owner, device, peer)).toMatchObject({ complete: true, revoked: true })
    await saveDeviceHistoryPair(owner, device, { ...pair, complete: false })
    expect(deviceHistoryPair(owner, device, peer)?.revoked).toBe(true)
    await saveDeviceHistoryPair(owner, device, { ...pair, linkId: 'd'.repeat(64), complete: false })
    expect(deviceHistoryPair(owner, device, peer)?.revoked).toBeUndefined()
  })
})

describe('durable history admission', () => {
  it('admits once, then suppresses deleted messages across storage reloads', async () => {
    expect(await isHistoryMessageSettled({ id: stored.id, chatId: device, createdAt: 100 })).toBe(false)
    expect(await admitHistoryMessage(stored)).toBe(true)
    expect(await isHistoryMessageSettled({ id: stored.id, chatId: device, createdAt: 100 })).toBe(true)
    expect(await admitHistoryMessage(stored)).toBe(false)
    await deleteMessage(stored.id)
    expect(await isHistoryMessageSettled({ id: stored.id, chatId: device, createdAt: 100 })).toBe(true)
    expect(await admitHistoryMessage(stored)).toBe(false)
    const tombstones = []; for await (const record of deletedHistoryRecords()) tombstones.push(record)
    expect(tombstones).toEqual([{ chatId: device, id: stored.id, createdAt: 100 }])
    expect(await db.messages.get(stored.id)).toBeUndefined()
  })
  it('suppresses removed chat history while allowing new live-era messages', async () => {
    await saveMessage(stored)
    await deleteMessagesForSession(device)
    expect(await admitHistoryMessage({ ...stored, id: 'old-unseen' })).toBe(false)
    expect(await admitHistoryMessage({ ...stored, id: 'new', timestamp: Date.now() + 2000 })).toBe(true)
  })
  it('rechecks authorization at admission', async () => {
    expect(await admitHistoryMessage(stored, () => false)).toBe(false)
    expect(await db.messages.count()).toBe(0)
  })
})

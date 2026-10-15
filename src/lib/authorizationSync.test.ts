import 'fake-indexeddb/auto'
import { beforeEach, expect, it, vi } from 'vitest'
import { AppKeys, buildGroupRosterFactEvent } from 'nostr-double-ratchet'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'
import { applyAuthorizationEvent, authorizationById, authorizationEvent, authorizationEvents, restoreAuthorizationProjections, saveAuthorizationEvent } from './authorizationSync'
import { db } from './storage'
import { createDeviceSyncRecordAdapter } from './deviceSyncRecordAdapter'
import { encodeDeviceSyncPacket, parseDeviceSyncPacket } from './deviceSyncProtocol'
import { deviceSyncRecordId } from './deviceSyncRecords'

const applyProof = vi.hoisted(() => vi.fn())
vi.mock('./privateChats', () => ({ getNdrRuntime: () => ({ applyVerifiedAppKeysEvent: applyProof }) }))
vi.mock('./groups', () => ({ applySyncedGroupRosterFact: applyProof }))

beforeEach(async () => { await db.sessionManager.clear(); await db.messages.clear(); await db.sessions.clear(); await db.groups.clear() })
it('reconciles exact signed device and group proofs after restart, without conflating their IDs', async () => {
  const secret = generateSecretKey(), owner = getPublicKey(secret), device = 'b'.repeat(64)
  const proofs = [
    finalizeEvent(new AppKeys([{identityPubkey: device, createdAt: 100}]).getEvent({ownerPubkey: owner, createdAt: 100}), secret),
    finalizeEvent(buildGroupRosterFactEvent({id:'group-test',name:'Friends',members:[owner,device],admins:[owner],createdAt:100000,accepted:true}, {signerPubkey:owner,revision:1,createdBy:owner,updatedAt:100,eventCreatedAt:100}), secret),
  ]
  for (const event of proofs) expect(await saveAuthorizationEvent(owner, event)).toBe(true)
  db.close(); await db.open()
  const adapter = createDeviceSyncRecordAdapter({owner, snapshots:()=>[], messages:()=>[], allowsLegacy:()=>false,applySnapshot:async()=>0})
  const refs = await adapter.recordInventory('state',0,0,false)
  expect(refs.map(ref=>ref.id).sort()).toEqual(proofs.map(event=>event.id).sort())
  const records = await adapter.records('state',0,0,refs,device)
  const packet = {v:1 as const,type:'historyRecords' as const,session:'1'.repeat(32),records,requested:refs.map(ref=>ref.id)}
  expect(parseDeviceSyncPacket(encodeDeviceSyncPacket(packet),owner)).toEqual(packet)
  expect(records.map(deviceSyncRecordId).sort()).toEqual(proofs.map(event=>event.id).sort())
  const other = []; for await (const event of authorizationEvents(device)) other.push(event)
  expect(other).toEqual([])
  for (const event of proofs) {
    expect(authorizationEvent({...event, sig:'0'.repeat(128)})).toBeUndefined()
    const {sig, ...unsigned} = event
    expect(authorizationEvent(unsigned)).toBeUndefined()
    expect(await saveAuthorizationEvent(owner,event,()=>false)).toBe(false)
  }
})

it.each(['device', 'group'])('does not advertise a %s proof before its projection is durable', async (type: string) => {
  const secret = generateSecretKey(), owner = getPublicKey(secret), device = 'b'.repeat(64)
  const unsigned = type === 'device'
    ? new AppKeys([{ identityPubkey: device, createdAt: 100 }]).getEvent({ ownerPubkey: owner, createdAt: 100 })
    : buildGroupRosterFactEvent({ id: 'group-test', name: 'Friends', members: [owner, device], admins: [owner], createdAt: 100000, accepted: true }, { signerPubkey: owner, revision: 1, createdBy: owner, updatedAt: 100, eventCreatedAt: 100 })
  const event = finalizeEvent(unsigned, secret)
  applyProof.mockRejectedValueOnce(new Error('Storage unavailable'))
  await expect(applyAuthorizationEvent(owner, event, () => true)).rejects.toThrow('Storage unavailable')
  db.close(); await db.open()
  expect(await authorizationById(owner, event.id)).toBeUndefined()
  applyProof.mockResolvedValueOnce(undefined)
  await applyAuthorizationEvent(owner, event, () => true)
  expect(await authorizationById(owner, event.id)).toEqual(structuredClone(event))
})

it('replays stored relay evidence after an interrupted projection save', async () => {
  const secret = generateSecretKey(), owner = getPublicKey(secret)
  const historical = finalizeEvent(new AppKeys([]).getEvent({ ownerPubkey: owner, createdAt: 100 }), secret)
  const event = finalizeEvent(new AppKeys([{ identityPubkey: 'b'.repeat(64), createdAt: 101 }]).getEvent({ ownerPubkey: owner, createdAt: 101 }), secret)
  await saveAuthorizationEvent(owner, historical)
  await saveAuthorizationEvent(owner, event)
  db.close(); await db.open()
  applyProof.mockClear().mockResolvedValue(undefined)
  await restoreAuthorizationProjections(owner, () => true)
  expect(applyProof).toHaveBeenCalledTimes(1)
  expect(applyProof).toHaveBeenCalledWith(structuredClone(event))
  applyProof.mockClear()
  await expect(restoreAuthorizationProjections(owner, () => false)).rejects.toThrow('Account changed')
  expect(applyProof).not.toHaveBeenCalled()
})

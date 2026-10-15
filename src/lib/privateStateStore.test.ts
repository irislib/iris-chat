import 'fake-indexeddb/auto'
import { beforeEach, expect, it } from 'vitest'
import { get } from 'svelte/store'
import { finalizeEvent, getPublicKey } from 'nostr-tools'
import { db } from './storage'
import { privateEventState, blockedIntervals } from './privateStateProtocol'
import { savePrivateStateEvent, projectMessageRead, applyMessageRead, privateHistoryAllowed, privateStateRecords, isPrivatelyBlocked, privateStateVersion, privateDirectPublicationPolicy } from './privateStateStore'
import { assertPrivatePublicationPolicy } from './privatePublishPolicy'
import { deviceSyncRecordId } from './deviceSyncRecords'
import { encodeDeviceSyncPacket, parseDeviceSyncPacket } from './deviceSyncProtocol'
const key = new Uint8Array(32).fill(3), owner = getPublicKey(key), contact = 'a'.repeat(64)
const event = (kind: number, content: object, time: number) => finalizeEvent({ kind, content: JSON.stringify(content), created_at: time,
  tags: [['p', owner], ['d', `iris:${kind === 10454 ? 'block' : 'name-approval'}:${contact}`]] }, key)
const block = (blocked: boolean, revision: number, since: number | null, time: number) => event(10454, { v: 1, owner, target: contact, blocked, revision, blockedSince: since, deletedAt: 0 }, time)
beforeEach(async () => { await db.messages.clear(); await db.sessionManager.clear(); localStorage.clear() })
it('retains separate block intervals across restart and preserves earlier history', async () => {
  const events = [block(true,1,100,100), block(false,2,100,120), block(true,3,140,140), block(false,4,140,160)]
  for (const entry of [...events].reverse()) await savePrivateStateEvent(owner, entry, () => true)
  db.close(); await db.open()
  expect(await isPrivatelyBlocked(owner, contact)).toBe(false)
  for (const [time, allowed] of [[99,true],[100,false],[119,false],[120,true],[139,true],[140,false],[160,true]] as const) expect(await privateHistoryAllowed(owner, contact, time)).toBe(allowed)
  expect(blockedIntervals(events)).toEqual([[100,120],[100,120],[140,160],[140,160]])
  expect(await privateHistoryAllowed('b'.repeat(64),contact,110)).toBe(true)
  for (const entry of events) expect(() => assertPrivatePublicationPolicy(entry)).toThrow()
})
it('orders signed name approvals exactly like native without replacing nicknames', async () => {
  localStorage.setItem(`iris-contact-memory:v1:${owner}:${contact}`, JSON.stringify({ favorite: true, nickname: 'Tea friend' }))
  const approval = event(10455, { v:1, owner, contact, revision:1, firstSeenName:'Old', change:{previous_name:'Old',accepted_name:'New',accepted_at_secs:100} },100)
  await savePrivateStateEvent(owner, approval, () => true)
  expect(JSON.parse(localStorage.getItem(`iris-contact-memory:v1:${owner}:${contact}`)!)).toMatchObject({ accepted_name:'New',nickname:'Tea friend',favorite:true })
  expect(privateEventState({ ...approval, content: approval.content + ' ' })).toBeUndefined()
  await expect(savePrivateStateEvent('b'.repeat(64), approval, () => true)).rejects.toThrow()
  await expect(savePrivateStateEvent(owner, approval, () => false)).rejects.toThrow()
  expect(() => assertPrivatePublicationPolicy(approval)).toThrow()
})
it('recovers exact reads before originals, preserving expiry and leaving unseen neighbors unread', async () => {
  const expires = Math.floor(Date.now()/1000)+3600
  await applyMessageRead(owner, contact, 'seen', { createdAtSecs:100,expiresAtSecs:expires }, () => true)
  const version = get(privateStateVersion)
  await applyMessageRead(owner, contact, 'seen', { createdAtSecs:100,expiresAtSecs:expires }, () => true)
  expect(get(privateStateVersion)).toBe(version)
  db.close(); await db.open()
  const original = { id:'seen',sessionId:contact,content:'Hello',timestamp:100000,isMine:false }
  expect((await projectMessageRead(owner,original)).status).toBe('seen')
  expect((await projectMessageRead(owner,{...original,id:'neighbor'})).status).toBeUndefined()
  expect((await projectMessageRead(owner,{...original,timestamp:101000})).status).toBeUndefined()
  expect((await projectMessageRead(owner,{...original,isMine:true})).status).toBeUndefined()
  const records = []; for await (const record of privateStateRecords(owner)) records.push(record)
  expect(records).toContainEqual({type:'messageRead',chatId:contact,messageId:'seen',read:{createdAtSecs:100,expiresAtSecs:expires}})
  const packet = {v:1 as const,type:'historyRecords' as const,session:'1'.repeat(32),records,requested:[]}
  expect(parseDeviceSyncPacket(encodeDeviceSyncPacket(packet),owner)).toEqual(packet)
  expect(deviceSyncRecordId(records[0])).toHaveLength(64)
  await applyMessageRead(owner,contact,'expired',{createdAtSecs:100,expiresAtSecs:101},()=>true)
  expect((await projectMessageRead(owner,{...original,id:'expired'})).status).toBeUndefined()
})
it('rejects private facts and controls from every public publication path', () => {
  for (const kind of [7368, 37368]) {
    expect(() => assertPrivatePublicationPolicy({ kind, tags: [['type', 'private_contact']] })).toThrow()
    expect(() => assertPrivatePublicationPolicy({ kind, tags: [['type', 'app_keys']] })).not.toThrow()
  }
  for (const kind of [10454, 10455, 10456]) expect(() => assertPrivatePublicationPolicy({ kind, tags: [] })).toThrow()
})

it('retires old outgoing work permanently and holds newer work until unblock', async () => {
  await savePrivateStateEvent(owner, block(true,1,100,100), () => true)
  expect(await privateDirectPublicationPolicy(owner,contact,99)).toBe(false)
  expect(await privateDirectPublicationPolicy(owner,contact,110)).toBe('hold')
  await savePrivateStateEvent(owner, block(false,2,100,120), () => true)
  db.close(); await db.open()
  expect(await privateDirectPublicationPolicy(owner,contact,119)).toBe(false)
  expect(await privateDirectPublicationPolicy(owner,contact,120)).toBe(true)
})

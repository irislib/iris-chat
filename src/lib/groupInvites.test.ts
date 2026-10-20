import 'fake-indexeddb/auto'
import { beforeEach, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
const owner = 'a'.repeat(64), issuer = 'b'.repeat(64), peer1 = 'c'.repeat(64), peer2 = 'd'.repeat(64), token = 'e'.repeat(64)
const mocks = vi.hoisted(() => ({ send: vi.fn(), publish: vi.fn() }))
vi.mock('./privateStateStore', () => ({ isPrivatelyBlocked: async () => false }))
vi.mock('./identity', () => ({ getPubkey: () => 'a'.repeat(64) }))
vi.mock('./privateChats', () => {
  const runtime = { getState: () => ({ currentDevicePubkey: 'b'.repeat(64) }), sendEvent: mocks.send, acceptInvite: vi.fn() }
  return { getNdrRuntime: () => runtime, waitForSendReadyRuntime: async () => runtime }
})
vi.mock('./chat', () => ({ createInvite: vi.fn(), personalInviteRecord: vi.fn(), inviteFromRecord: vi.fn(), markGroupInviteConnection: vi.fn(),
  buildManagerRumorOptions: (recipient: string) => ({ pubkey: 'a'.repeat(64), tags: [['p', recipient]] }) }))
vi.mock('./inviteRecordStore', () => ({ publishInviteRecord: vi.fn() }))
vi.mock('./groups', async () => {
  const { writable } = await import('svelte/store')
  return { groups: writable(new Map()), publishAdmittedGroup: mocks.publish,
    canSendToGroup: (group: {members:string[],accepted:boolean}, owner: string) => group.accepted && group.members.includes(owner),
    isAdmin: (group: {admins:string[]}, owner:string) => group.admins.includes(owner) }
})
import { db } from './storage'
import { admissionDecision, groupInviteLinks, requestGroupJoin, receiveGroupInviteControl, type GroupInviteGrant } from './groupInvites'
import { groups, type Group } from './groups'
const group: Group = { id: 'picnic', name: 'Picnic', members: [owner], admins: [owner], accepted: true, createdAt: 1, secret: 'f'.repeat(64), protocol: 'sender_key_v1' }
const grant: GroupInviteGrant = { reference: 'private-reference', revoked: false, usedBy: [], record: { v: 1, type: 'group', name: 'Picnic', nonce: token, groupId: group.id, token, maxUses: 1,
  invite: { version: 2, owner, inviter: issuer, ephemeralKey: token, sharedSecret: token } } }
const key = `group-invite-v1:${owner}:${token}`
async function join(peer: string) {
  await receiveGroupInviteControl({ kind: 10461, id: peer, pubkey: peer2, content: JSON.stringify({ v:1, groupId: group.id, token }), created_at: 1, tags: [] }, { senderOwnerPubkey: peer, senderDevicePubkey: peer, isSelf: false } as never)
}
beforeEach(async () => {
  mocks.send.mockReset(); mocks.publish.mockReset()
  await db.groups.clear(); await db.sessionManager.clear()
  await db.groups.put(group); await db.sessionManager.put({key, value: structuredClone(grant)})
  groups.set(new Map([[group.id, group]]))
})
it('preserves old issued links locally while excluding them from sharing and admission', async () => {
  const old = structuredClone(grant)
  delete (old.record.invite as { version?: number }).version
  await db.sessionManager.put({ key, value: old })
  expect(await groupInviteLinks(group.id)).toEqual([])
  expect(admissionDecision(old, group, owner, peer1, 1)).toBe('unavailable')
  expect(await db.sessionManager.get(key)).toBeDefined()
})
it('atomically enforces a use limit for simultaneous authenticated requests', async () => {
  await Promise.all([join(peer1), join(peer2)])
  expect((await db.groups.get(group.id))!.members).toHaveLength(2)
  const saved = (await db.sessionManager.get(key))!.value as GroupInviteGrant
  expect(saved.usedBy).toHaveLength(1)
  expect(mocks.send.mock.calls.map((call: unknown[]) => JSON.parse((call[1] as {content:string}).content).status).sort()).toEqual(['added', 'full'])
})
it('authors join requests and results as the authenticated account for native peers', async () => {
  await requestGroupJoin(grant.record)
  expect(mocks.send).toHaveBeenLastCalledWith(owner,
    expect.objectContaining({ kind: 10461, pubkey: owner, tags: [['p', owner]] }), owner, { includeLocalSiblings: false })
  await join(peer1)
  expect(mocks.send).toHaveBeenLastCalledWith(peer1,
    expect.objectContaining({ kind: 10462, pubkey: owner, tags: [['p', peer1]] }), owner, { includeLocalSiblings: false })
})
it('does not spend another use on retry and never readmits a removed member', async () => {
  await join(peer1); await join(peer1)
  expect(((await db.sessionManager.get(key))!.value as GroupInviteGrant).usedBy).toEqual([peer1])
  await db.groups.put(group)
  await join(peer1)
  expect((await db.groups.get(group.id))!.members).toEqual([owner])
  expect(JSON.parse(mocks.send.mock.calls.at(-1)![1].content).status).toBe('used')
})
it('requires a current admin, live invitation and transport-authenticated requester', async () => {
  expect(admissionDecision({...grant, revoked:true}, group, owner, peer1, 1)).toBe('unavailable')
  expect(admissionDecision(grant, {...group,admins:[]}, owner, peer1, 1)).toBe('unavailable')
  expect(admissionDecision({...grant, record:{...grant.record,expiresAt:1}}, group, owner, peer1, 1)).toBe('expired')
  await receiveGroupInviteControl({kind:10461, content:JSON.stringify({v:1,groupId:group.id,token}),pubkey:peer1} as never)
  expect(mocks.send).not.toHaveBeenCalled()
  expect(get(groups).get(group.id)!.members).toEqual([owner])
})

it('ignores malformed authenticated controls without poisoning durable delivery', async () => {
  for (const content of ['null', '[]', 'false', '{', '{}']) {
    await expect(receiveGroupInviteControl({kind:10461, content} as never,
      {senderOwnerPubkey:peer1, senderDevicePubkey:peer1} as never)).resolves.toBeUndefined()
  }
  expect(mocks.send).not.toHaveBeenCalled()
})

it('publishes concurrent successful admissions in membership order', async () => {
  await db.sessionManager.put({key, value:{...grant, record:{...grant.record, maxUses:2}}})
  const snapshots: string[][] = []
  mocks.publish.mockImplementation(async (next: Group) => { snapshots.push([...next.members]); await Promise.resolve() })
  await Promise.all([join(peer1), join(peer2)])
  expect(snapshots.map(members => members.length)).toEqual([2, 3])
  expect(new Set(snapshots[1])).toEqual(new Set([owner, peer1, peer2]))
})

import { get, writable } from 'svelte/store'
import { addGroupMember as addMember, type Rumor, type OnEventMeta } from 'nostr-double-ratchet'
import { getPubkey } from './identity'
import { isPrivatelyBlocked } from './privateStateStore'
import { getNdrRuntime, waitForSendReadyRuntime } from './privateChats'
import { createInvite, personalInviteRecord, inviteFromRecord, markGroupInviteConnection, buildManagerRumorOptions } from './chat'
import { groups, publishAdmittedGroup, canSendToGroup, isAdmin, type Group } from './groups'
import { db } from './storage'
import { publishInviteRecord } from './inviteRecordStore'
import type { InviteRecord } from './inviteRecord'

export const GROUP_JOIN_REQUEST_KIND = 10461
export const GROUP_JOIN_RESULT_KIND = 10462
export interface GroupInviteGrant {
  record: InviteRecord
  reference: string
  revoked: boolean
  usedBy: string[]
}
export type Admission = 'added' | 'already-member' | 'used' | 'unavailable' | 'expired' | 'full'
export function admissionDecision(grant: GroupInviteGrant, group: Group | undefined, owner: string, peer: string, now: number): Admission {
  if (grant.record.invite.version !== 2 || grant.revoked || !group || !canSendToGroup(group, owner) || !isAdmin(group, owner) ||
    grant.record.invite.owner !== owner || group.id !== grant.record.groupId) return 'unavailable'
  // A removed member cannot use the same invitation again, even on another device.
  if (grant.usedBy.includes(peer)) return group.members.includes(peer) ? 'already-member' : 'used'
  if (grant.record.expiresAt && grant.record.expiresAt <= now) return 'expired'
  if (group.members.includes(peer)) return 'already-member'
  if (grant.record.maxUses !== undefined && grant.usedBy.length >= grant.record.maxUses) return 'full'
  return 'added'
}
const admissionQueues = new Map<string, Promise<void>>()
const prefix = (owner: string) => `group-invite-v1:${owner}:`
const key = (owner: string, token: string) => prefix(owner) + token
export async function groupInviteLinks(groupId: string): Promise<GroupInviteGrant[]> {
  const owner = getPubkey(); if (!owner) return []
  return (await db.sessionManager.where('key').startsWith(prefix(owner)).toArray())
    .map(row => row.value as GroupInviteGrant).filter(grant => grant.record.invite.version === 2 && grant.record.groupId === groupId && !grant.revoked)
}
export async function createGroupInvite(groupId: string, maxUses?: number, expiresAt?: number): Promise<GroupInviteGrant> {
  const owner = getPubkey(), group = get(groups).get(groupId)
  if (!owner || !group || !canSendToGroup(group, owner) || !isAdmin(group, owner)) throw new Error('Only group admins can create invites.')
  const invite = await createInvite()
  if (invite.type !== 'legacy') throw new Error('Invite is not ready')
  const record: InviteRecord = { ...await personalInviteRecord(invite.invite), type: 'group', name: group.name.slice(0, 100), groupId,
    token: Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''),
    ...(maxUses !== undefined && { maxUses }), ...(expiresAt !== undefined && { expiresAt }) }
  const reference = await publishInviteRecord(record)
  if (getPubkey() !== owner) throw new Error('Account changed')
  const grant: GroupInviteGrant = { record, reference, revoked: false, usedBy: [] }
  await db.sessionManager.put({ key: key(owner, record.token!), value: grant })
  return grant
}
export async function revokeGroupInvite(grant: GroupInviteGrant): Promise<void> {
  const owner = getPubkey(); if (!owner) return
  await db.transaction('rw', db.sessionManager, async () => {
    const row = await db.sessionManager.get(key(owner, grant.record.token!))
    if (row) await db.sessionManager.put({ ...row, value: { ...row.value as GroupInviteGrant, revoked: true } })
  })
}
export const groupJoinStatus = writable<Record<string, string>>({})
const pendingKey = (owner: string, groupId: string) => `group-join-v1:${owner}:${groupId}`

export async function requestGroupJoin(record: InviteRecord): Promise<string> {
  if (record.type !== 'group' || !record.groupId || !record.token) throw new Error('Invalid group invite')
  const owner = getPubkey(); if (!owner) throw new Error('Not logged in')
  const runtime = await waitForSendReadyRuntime()
  await runtime.acceptInvite(inviteFromRecord(record), { ownerPublicKey: record.invite.owner })
  if (getPubkey() !== owner) throw new Error('Account changed')
  await db.sessionManager.put({ key: pendingKey(owner, record.groupId), value: record })
  await sendJoinRequest(record)
  return record.groupId
}
async function sendJoinRequest(record: InviteRecord): Promise<void> {
  if (record.invite.version !== 2) throw new Error('Ask for a new invite link.')
  const owner = getPubkey(); if (!owner) throw new Error('Not logged in')
  const runtime = await waitForSendReadyRuntime()
  if (getPubkey() !== owner) throw new Error('Account changed')
  groupJoinStatus.update(value => ({ ...value, [record.groupId!]: 'Waiting for the group admin to connect…' }))
  await runtime.sendEvent(record.invite.owner, {
    kind: GROUP_JOIN_REQUEST_KIND, content: JSON.stringify({ v: 1, groupId: record.groupId, token: record.token }),
    ...buildManagerRumorOptions(record.invite.owner),
  }, owner, { includeLocalSiblings: false })
}
export async function retryGroupJoin(groupId: string): Promise<void> {
  const owner = getPubkey(); if (!owner) return
  const record = (await db.sessionManager.get(pendingKey(owner, groupId)))?.value as InviteRecord | undefined
  if (!record) throw new Error('Open the invite link to try again.')
  if (record.expiresAt && record.expiresAt <= Date.now() / 1000) throw new Error('This invite has expired.')
  await sendJoinRequest(record)
}

export async function receiveGroupInviteControl(rumor: Rumor, meta?: OnEventMeta): Promise<void> {
  const owner = getPubkey(), peer = meta?.senderOwnerPubkey
  if (!owner || !peer || peer === owner || meta?.isSelf || rumor.content.length > 1024 || await isPrivatelyBlocked(owner, peer)) return
  let payload: { v: number; groupId: string; token: string; status?: string }
  try { payload = JSON.parse(rumor.content) } catch { return }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.v !== 1 || typeof payload.groupId !== 'string' || payload.groupId.length > 128 ||
    !/^[0-9a-f]{64}$/.test(payload.token)) return
  if (rumor.kind === GROUP_JOIN_RESULT_KIND) {
    const pending = (await db.sessionManager.get(pendingKey(owner, payload.groupId)))?.value as InviteRecord | undefined
    if (!pending || pending.invite.version !== 2 || pending.invite.owner !== peer || pending.token !== payload.token || pending.invite.inviter !== meta?.senderDevicePubkey) return
    const labels: Record<string, string> = { added: 'Joining group…', 'already-member': 'Joining group…',
      unavailable: 'This invite is no longer available.', expired: 'This invite has expired.', full: 'This invite has reached its use limit.', used: 'This invite has already been used.' }
    if (typeof payload.status === 'string' && Object.hasOwn(labels, payload.status)) groupJoinStatus.update(s => ({ ...s, [payload.groupId]: labels[payload.status!] }))
    return
  }
  if (rumor.kind !== GROUP_JOIN_REQUEST_KIND) return
  // Serialize admission and publication together so simultaneous joins cannot
  // apply an older roster after a newer one has already committed.
  const queueKey = `${owner}:${payload.groupId}`
  const pending = (admissionQueues.get(queueKey) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (getPubkey() !== owner) return
    let nextGroup: Group | undefined
    let status: Admission | undefined
    // Membership and the use ledger commit together. Concurrent requests cannot
    // overspend the limit; replay after removal cannot restore membership.
    await db.transaction('rw', db.sessionManager, db.groups, async () => {
      const row = await db.sessionManager.get(key(owner, payload.token))
      if (!row) return // Other devices of the admin do not own this invitation.
      const grant = row.value as GroupInviteGrant
      if (grant.record.groupId !== payload.groupId || grant.record.invite.inviter !== getNdrRuntime().getState().currentDevicePubkey) return
      const group = await db.groups.get(payload.groupId) as Group | undefined
      status = admissionDecision(grant, group, owner, peer, Math.floor(Date.now() / 1000))
      if (status === 'added' && group) {
        nextGroup = addMember(group, peer, owner) ?? undefined
        if (!nextGroup) { status = 'unavailable'; return }
        await db.groups.put(nextGroup)
        await db.sessionManager.put({ ...row, value: { ...grant, usedBy: [...grant.usedBy, peer] } })
      } else if (status === 'already-member') nextGroup = group
    })
    if (!status || getPubkey() !== owner) return
    await markGroupInviteConnection(peer)
    if (nextGroup) await publishAdmittedGroup(nextGroup)
    if (getPubkey() !== owner) return
    await getNdrRuntime().sendEvent(peer, { kind: GROUP_JOIN_RESULT_KIND,
      content: JSON.stringify({ ...payload, status }), ...buildManagerRumorOptions(peer) }, owner, { includeLocalSiblings: false })
  })
  admissionQueues.set(queueKey, pending)
  try { await pending }
  finally { if (admissionQueues.get(queueKey) === pending) admissionQueues.delete(queueKey) }
}

// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { createLocalNostrIdentitySession } from '@iris/identity/session'
import {
  parseNostrIdentityDeviceApprovalReceiptEvent,
  parseNostrIdentityDeviceApprovalReceiptRosterOp,
  projectNostrIdentityRoster,
} from 'nostr-social-graph'
import {
  buildLinkedNostrIdentitySessionFromApproval,
  buildNostrIdentityChatDeviceApprovalEvents,
  createNostrIdentityChatDeviceApprovalRequest,
  parseNostrIdentityChatDeviceApprovalRequest,
} from './nostrIdentityDeviceLink'

const PROFILE_ID = '6b7f5df4-1d2d-43a7-9b87-873e41a2d99a'
const SUBJECT_PUBKEY = 'f'.repeat(64)

describe('nostrIdentityDeviceLink', () => {
  it('encodes scan-to-approve requests as one device pubkey plus one request secret', () => {
    const deviceAppKeySecretKey = generateSecretKey()
    const requestSecretKey = generateSecretKey()
    const local = createNostrIdentityChatDeviceApprovalRequest({
      deviceAppKeySecretKey,
      requestSecretKey,
      requestedAt: 41,
      label: 'Iris Chat Web',
    })

    expect(local.url.startsWith('nostr-identity://device-approval/')).toBe(true)
    expect(local.url).not.toContain('https://chat.iris.to')
    expect(local.url).not.toContain('nostrconnect:')
    expect(local.url).not.toContain('relay=')
    expect(local.url.length).toBeLessThanOrEqual(170)
    expect(local.request.deviceAppKeyPubkey).toBe(getPublicKey(deviceAppKeySecretKey))
    expect(local.request.requestPubkey).toBe(getPublicKey(requestSecretKey))
    expect(local.request.requestSecret).toBe(toHex(requestSecretKey))
    expect(local.request.deviceAppKeyProof).toBe('')

    const payload = local.url.replace('nostr-identity://device-approval/', '')
    expect(payload.split('.')).toEqual([local.request.deviceAppKeyPubkey, toHex(requestSecretKey)])

    const parsed = parseNostrIdentityChatDeviceApprovalRequest(local.url)
    expect(parsed?.request.requestPubkey).toBe(local.request.requestPubkey)
    expect(parsed?.request.deviceAppKeyPubkey).toBe(local.request.deviceAppKeyPubkey)
    expect(parsed?.request.requestSecret).toBe(local.request.requestSecret)
    expect(parsed?.request.deviceAppKeyProof).toBe('')
    expect(parsed?.request.label).toBeUndefined()
  })

  it('rejects malformed approval codes', () => {
    expect(parseNostrIdentityChatDeviceApprovalRequest('https://chat.iris.to/')).toBeNull()
    expect(
      parseNostrIdentityChatDeviceApprovalRequest('nostr-identity://device-approval/abc')
    ).toBeNull()
  })

  it('approves requests with NostrIdentity roster ops and saves the linked AppKey session', () => {
    const adminAppKeySecretKey = generateSecretKey()
    const adminSession = createLocalNostrIdentitySession({
      profileId: PROFILE_ID,
      appKeySecretKey: adminAppKeySecretKey,
      createdAt: 40,
      clientNonce: 'bootstrap-admin',
      label: 'Admin',
    })
    const deviceAppKeySecretKey = generateSecretKey()
    const local = createNostrIdentityChatDeviceApprovalRequest({
      deviceAppKeySecretKey,
      requestedAt: 41,
      label: 'Linked browser',
    })

    const approval = buildNostrIdentityChatDeviceApprovalEvents({
      request: local.request,
      adminSession,
      subjectPubkey: SUBJECT_PUBKEY,
      approvedAt: 42,
    })

    expect(approval.rosterEvent.kind).toBe(7368)
    expect(approval.rosterEvent.tags).toContainEqual(['type', 'nostr_identity_roster_op'])
    expect(JSON.stringify(approval.rosterEvent.tags)).not.toContain('double-ratchet/app-keys')

    const receipt = parseNostrIdentityDeviceApprovalReceiptEvent(approval.receiptEvent, {
      requestSecretKey: local.request.requestSecretKey,
      request: local.request,
      profileId: PROFILE_ID,
      approvedByPubkey: adminSession.appKeyPubkey,
    })
    expect(receipt.subjectPubkey).toBe(SUBJECT_PUBKEY)
    const receiptRosterOp = parseNostrIdentityDeviceApprovalReceiptRosterOp(receipt)
    expect(receiptRosterOp.op_id).toBe(approval.signedRosterOp.op_id)

    const linkedSession = buildLinkedNostrIdentitySessionFromApproval({
      request: local.request,
      receipt,
      deviceAppKeySecretKey,
      rosterOps: [...adminSession.rosterOps, receiptRosterOp],
    })
    expect(linkedSession.profileId).toBe(PROFILE_ID)
    expect(linkedSession.appKeyPubkey).toBe(local.request.deviceAppKeyPubkey)
    const projection = projectNostrIdentityRoster(PROFILE_ID, linkedSession.rosterOps)
    expect(projection.active_facets[local.request.deviceAppKeyPubkey]).toBeTruthy()
  })
})

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

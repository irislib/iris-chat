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
  it('encodes scan-to-approve requests with the chat prefix and device AppKey proof', () => {
    const deviceAppKeySecretKey = generateSecretKey()
    const requestSecretKey = generateSecretKey()
    const local = createNostrIdentityChatDeviceApprovalRequest({
      deviceAppKeySecretKey,
      requestSecretKey,
      requestedAt: 41,
      label: 'Iris Chat Web',
      relays: ['wss://relay.example'],
    })

    expect(local.url.startsWith('https://chat.iris.to/approve-device/')).toBe(true)
    expect(local.url).not.toContain('nostrconnect:')
    expect(local.request.deviceAppKeyPubkey).toBe(getPublicKey(deviceAppKeySecretKey))
    expect(local.request.requestPubkey).toBe(getPublicKey(requestSecretKey))
    expect(local.request.deviceAppKeyProof).toContain('nostr_identity_device_approval_proof')

    const parsed = parseNostrIdentityChatDeviceApprovalRequest(local.url)
    expect(parsed?.request).toEqual({
      requestPubkey: local.request.requestPubkey,
      deviceAppKeyPubkey: local.request.deviceAppKeyPubkey,
      requestSecret: local.request.requestSecret,
      deviceAppKeyProof: local.request.deviceAppKeyProof,
      requestedAt: local.request.requestedAt,
      label: local.request.label,
    })
    expect(parsed?.relays).toEqual(['wss://relay.example'])
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

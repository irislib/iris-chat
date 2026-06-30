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
  createNdrLinkInviteForDeviceApprovalRequest,
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

    expect(local.url).toMatch(/^[0-9a-f]{64}\.[0-9a-f]{64}$/)
    expect(local.url).not.toContain('https://chat.iris.to')
    expect(local.url).not.toContain('nostr-identity://device-approval/')
    expect(local.url).not.toContain('nostrconnect:')
    expect(local.url).not.toContain('relay=')
    expect(local.url.length).toBe(129)
    expect(local.request.deviceAppKeyPubkey).toBe(getPublicKey(deviceAppKeySecretKey))
    expect(local.request.requestPubkey).toBe(getPublicKey(requestSecretKey))
    expect(local.request.requestSecret).toBe(toHex(requestSecretKey))
    expect(local.request.deviceAppKeyProof).toBe('')

    expect(local.url.split('.')).toEqual([local.request.deviceAppKeyPubkey, toHex(requestSecretKey)])

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
    expect(
      parseNostrIdentityChatDeviceApprovalRequest(
        `nostr-identity://device-approval/${'a'.repeat(64)}.${'b'.repeat(64)}`
      )
    ).toBeNull()
  })

  it('derives deterministic NDR link invites from the compact secret', () => {
    const requestSecret =
      '0100000017000000c8010000d21e000000000000000000000000000000000000'
    const deviceAppKeyPubkey = 'e'.repeat(64)
    const request = {
      requestPubkey: getPublicKey(hexToBytes(requestSecret)),
      deviceAppKeyPubkey,
      requestSecret,
      deviceAppKeyProof: '',
      requestedAt: 77,
    }

    const invite = createNdrLinkInviteForDeviceApprovalRequest(request)
    const repeated = createNdrLinkInviteForDeviceApprovalRequest({
      ...request,
      requestedAt: 88,
    })

    expect(toHex(invite.inviterEphemeralPrivateKey!)).toMatch(/^be3f1cca6354c294/)
    expect(invite.inviterEphemeralPublicKey).toBe(repeated.inviterEphemeralPublicKey)
    expect(invite.sharedSecret).toBe(repeated.sharedSecret)
    expect(invite.inviter).toBe(deviceAppKeyPubkey)
    expect(invite.deviceId).toBe(deviceAppKeyPubkey)
    expect(invite.maxUses).toBe(1)
    expect(invite.createdAt).toBe(0)
    expect(invite.purpose).toBe('link')
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

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

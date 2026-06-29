import { generateSecretKey, getPublicKey, nip19, type Event } from 'nostr-tools'
import type { NostrIdentitySession } from '@iris/identity/session'
import {
  approveNostrIdentityDeviceApprovalRequest,
  buildNostrIdentityDeviceApprovalReceiptEvent,
  buildNostrIdentityRosterOpEvent,
  createNostrIdentityDeviceApprovalRequest,
  encodeNostrIdentityDeviceApprovalRequest,
  parseNostrIdentityDeviceApprovalReceiptRosterOp,
  parseNostrIdentityDeviceApprovalRequest,
  parseNostrIdentityRosterOpEvent,
  projectNostrIdentityRoster,
  type LocalNostrIdentityDeviceApprovalRequest,
  type NostrIdentityDeviceApprovalReceipt,
  type NostrIdentityDeviceApprovalRequest,
  type SignedNostrIdentityRosterOp,
} from 'nostr-social-graph'

export const NOSTR_IDENTITY_CHAT_DEVICE_APPROVAL_PREFIX =
  'https://chat.iris.to/approve-device/'
export const NOSTR_IDENTITY_CHAT_DEVICE_APPROVAL_PATH = '/approve-device/'
export const NOSTR_IDENTITY_CHAT_DEVICE_LINK_TIMEOUT_MS = 120_000

export interface LocalNostrIdentityChatDeviceApprovalRequest {
  request: LocalNostrIdentityDeviceApprovalRequest
  deviceAppKeySecretKey: Uint8Array
  url: string
}

export interface ParsedNostrIdentityChatDeviceApprovalRequest {
  request: NostrIdentityDeviceApprovalRequest
  relays: string[]
}

export interface NostrIdentityChatDeviceApprovalEvents {
  rosterEvent: Event
  receiptEvent: Event
  signedRosterOp: SignedNostrIdentityRosterOp
  nextAdminSession: NostrIdentitySession
}

export const nostrIdentityChatDeviceApprovalPrefixes = (origin?: string): string[] => {
  const prefixes = [NOSTR_IDENTITY_CHAT_DEVICE_APPROVAL_PREFIX]
  const currentOrigin = origin ?? browserOrigin()
  if (currentOrigin) {
    prefixes.push(new URL(NOSTR_IDENTITY_CHAT_DEVICE_APPROVAL_PATH, currentOrigin).toString())
  }
  return Array.from(new Set(prefixes))
}

export const createNostrIdentityChatDeviceApprovalRequest = (options: {
  deviceAppKeySecretKey?: Uint8Array
  requestSecretKey?: Uint8Array
  requestSecret?: string
  requestedAt?: number
  label?: string
  relays?: string[]
  origin?: string
} = {}): LocalNostrIdentityChatDeviceApprovalRequest => {
  const deviceAppKeySecretKey = options.deviceAppKeySecretKey ?? generateSecretKey()
  const request = createNostrIdentityDeviceApprovalRequest({
    deviceAppKeySecretKey,
    ...(options.requestSecretKey ? { requestSecretKey: options.requestSecretKey } : {}),
    ...(options.requestSecret ? { requestSecret: options.requestSecret } : {}),
    requestedAt: options.requestedAt ?? currentUnixSeconds(),
    label: options.label ?? 'Iris Chat Web',
  })
  const [prefix] = nostrIdentityChatDeviceApprovalPrefixes(options.origin)
  const encoded = encodeNostrIdentityDeviceApprovalRequest(request, { prefix })
  return {
    request,
    deviceAppKeySecretKey,
    url: appendRelayParams(encoded, options.relays ?? []),
  }
}

export const parseNostrIdentityChatDeviceApprovalRequest = (
  input: string,
  options: { origin?: string } = {}
): ParsedNostrIdentityChatDeviceApprovalRequest | null => {
  const request = parseNostrIdentityDeviceApprovalRequest(input, {
    prefixes: nostrIdentityChatDeviceApprovalPrefixes(options.origin),
  })
  if (!request) return null
  return {
    request,
    relays: relayParamsFromInput(input),
  }
}

export const buildNostrIdentityChatDeviceApprovalEvents = (options: {
  request: NostrIdentityDeviceApprovalRequest
  adminSession: NostrIdentitySession
  subjectPubkey: string
  approvedAt?: number
  adminAppKeySecretKey?: Uint8Array
}): NostrIdentityChatDeviceApprovalEvents => {
  const adminSession = options.adminSession
  if (adminSession.status !== 'active') {
    throw new Error('NostrIdentity session is not active')
  }
  const signerSecretKey =
    options.adminAppKeySecretKey ?? secretKeyFromNsec(adminSession.appKeyNsec)
  const signerPubkey = getPublicKey(signerSecretKey)
  if (signerPubkey !== adminSession.appKeyPubkey) {
    throw new Error('NostrIdentity AppKey secret does not match the current session')
  }

  const approvedAt = options.approvedAt ?? currentUnixSeconds()
  const rosterOpContent = approveNostrIdentityDeviceApprovalRequest({
    request: options.request,
    profileId: adminSession.profileId,
    rosterOps: adminSession.rosterOps,
    approvedByPubkey: adminSession.appKeyPubkey,
    approvedAt,
  })
  const rosterEvent = buildNostrIdentityRosterOpEvent({
    signerSecretKey,
    profileId: adminSession.profileId,
    ...(rosterOpContent.parents ? { parents: rosterOpContent.parents } : {}),
    createdAt: rosterOpContent.created_at,
    clientNonce: rosterOpContent.client_nonce,
    op: rosterOpContent.op,
  })
  const signedRosterOp = parseNostrIdentityRosterOpEvent(rosterEvent)
  const receiptEvent = buildNostrIdentityDeviceApprovalReceiptEvent({
    signerSecretKey,
    request: options.request,
    profileId: adminSession.profileId,
    approvedAt,
    subjectPubkey: options.subjectPubkey,
    rosterOpEvent: rosterEvent,
  })

  const nextAdminSession = {
    ...adminSession,
    rosterOps: mergeNostrIdentityRosterOps(adminSession.rosterOps, [signedRosterOp]),
  }

  return {
    rosterEvent,
    receiptEvent,
    signedRosterOp,
    nextAdminSession,
  }
}

export const buildLinkedNostrIdentitySessionFromApproval = (options: {
  request: NostrIdentityDeviceApprovalRequest
  receipt: NostrIdentityDeviceApprovalReceipt
  deviceAppKeySecretKey: Uint8Array
  rosterOps: SignedNostrIdentityRosterOp[]
  createdAt?: number
}): NostrIdentitySession => {
  const appKeyPubkey = getPublicKey(options.deviceAppKeySecretKey)
  if (appKeyPubkey !== options.request.deviceAppKeyPubkey) {
    throw new Error('NostrIdentity device AppKey secret does not match the approval request')
  }
  if (options.receipt.deviceAppKeyPubkey !== options.request.deviceAppKeyPubkey) {
    throw new Error('NostrIdentity approval receipt is for a different device')
  }

  const receiptRosterOp = parseNostrIdentityDeviceApprovalReceiptRosterOp(options.receipt)
  const rosterOps = mergeNostrIdentityRosterOps(options.rosterOps, [receiptRosterOp])
  const projection = projectNostrIdentityRoster(options.receipt.profileId, rosterOps)
  if (!projection.active_facets[appKeyPubkey]) {
    throw new Error('Approved NostrIdentity roster does not activate this device')
  }

  return {
    profileId: options.receipt.profileId,
    appKeyPubkey,
    appKeyNpub: nip19.npubEncode(appKeyPubkey),
    appKeyNsec: nip19.nsecEncode(options.deviceAppKeySecretKey),
    status: 'active',
    rosterOps,
    createdAt: options.createdAt ?? options.request.requestedAt,
    ...(options.request.label ? { label: options.request.label } : {}),
  }
}

export const mergeNostrIdentityRosterOps = (
  existing: SignedNostrIdentityRosterOp[],
  next: SignedNostrIdentityRosterOp[]
): SignedNostrIdentityRosterOp[] => {
  const byId = new Map<string, SignedNostrIdentityRosterOp>()
  for (const op of [...existing, ...next]) {
    byId.set(op.op_id, op)
  }
  return Array.from(byId.values()).sort(
    (a, b) =>
      a.content.created_at - b.content.created_at ||
      a.op_id.localeCompare(b.op_id)
  )
}

export const secretKeyFromNsec = (nsec: string): Uint8Array => {
  const decoded = nip19.decode(nsec)
  if (decoded.type !== 'nsec' || !(decoded.data instanceof Uint8Array)) {
    throw new Error('NostrIdentity AppKey is not an nsec')
  }
  return decoded.data
}

const appendRelayParams = (input: string, relays: string[]): string => {
  const relayUrls = normalizeRelayUrls(relays)
  if (relayUrls.length === 0) return input
  const url = new URL(input)
  relayUrls.forEach((relay) => url.searchParams.append('relay', relay))
  return url.toString()
}

const relayParamsFromInput = (input: string): string[] => {
  const cleaned = cleanNostrPrefix(input)
  try {
    return normalizeRelayUrls(new URL(cleaned).searchParams.getAll('relay'))
  } catch {
    return []
  }
}

const normalizeRelayUrls = (relays: string[]): string[] =>
  Array.from(new Set(relays.map((relay) => relay.trim()).filter(Boolean)))

const cleanNostrPrefix = (input: string): string => {
  const trimmed = input.trim()
  return trimmed.toLowerCase().startsWith('nostr:') ? trimmed.slice('nostr:'.length) : trimmed
}

const browserOrigin = (): string | undefined => {
  if (typeof window === 'undefined') return undefined
  return window.location.origin
}

const currentUnixSeconds = (): number => Math.round(Date.now() / 1000)

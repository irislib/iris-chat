import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  nip44,
  type Event,
} from 'nostr-tools'
import type { NostrIdentitySession } from '@iris/identity/session'
import {
  approveNostrIdentityDeviceApprovalRequest,
  buildNostrIdentityRosterOpEvent,
  FACT_OP_KIND,
  NOSTR_IDENTITY_DEVICE_APPROVAL_RECEIPT_SCHEMA,
  NOSTR_IDENTITY_DEVICE_APPROVAL_RECEIPT_TYPE,
  parseNostrIdentityDeviceApprovalReceiptRosterOp,
  parseNostrIdentityRosterOpEvent,
  projectNostrIdentityRoster,
  type LocalNostrIdentityDeviceApprovalRequest,
  type NostrIdentityDeviceApprovalReceipt,
  type NostrIdentityDeviceApprovalRequest,
  type SignedNostrIdentityRosterOp,
} from 'nostr-social-graph'

export const NOSTR_IDENTITY_CHAT_DEVICE_APPROVAL_PREFIX =
  'nostr-identity://device-approval/'
export const NOSTR_IDENTITY_CHAT_DEVICE_LINK_TIMEOUT_MS = 120_000

export interface LocalNostrIdentityChatDeviceApprovalRequest {
  request: LocalNostrIdentityDeviceApprovalRequest
  deviceAppKeySecretKey: Uint8Array
  url: string
}

export interface ParsedNostrIdentityChatDeviceApprovalRequest {
  request: NostrIdentityDeviceApprovalRequest
}

export interface NostrIdentityChatDeviceApprovalEvents {
  rosterEvent: Event
  receiptEvent: Event
  signedRosterOp: SignedNostrIdentityRosterOp
  nextAdminSession: NostrIdentitySession
}

export const createNostrIdentityChatDeviceApprovalRequest = (options: {
  deviceAppKeySecretKey?: Uint8Array
  requestSecretKey?: Uint8Array
  requestedAt?: number
  label?: string
} = {}): LocalNostrIdentityChatDeviceApprovalRequest => {
  const deviceAppKeySecretKey = options.deviceAppKeySecretKey ?? generateSecretKey()
  const requestSecretKey = options.requestSecretKey ?? generateSecretKey()
  const requestSecret = hexFromBytes(requestSecretKey)
  const request: LocalNostrIdentityDeviceApprovalRequest = {
    requestPubkey: getPublicKey(requestSecretKey),
    requestSecretKey,
    deviceAppKeyPubkey: getPublicKey(deviceAppKeySecretKey),
    requestSecret,
    deviceAppKeyProof: '',
    requestedAt: options.requestedAt ?? currentUnixSeconds(),
    ...(options.label?.trim() ? { label: options.label.trim() } : {}),
  }
  const encoded = encodeCompactNostrIdentityChatDeviceApprovalRequest(request)
  return {
    request,
    deviceAppKeySecretKey,
    url: encoded,
  }
}

export const parseNostrIdentityChatDeviceApprovalRequest = (
  input: string
): ParsedNostrIdentityChatDeviceApprovalRequest | null => {
  const request = parseCompactNostrIdentityChatDeviceApprovalRequest(input)
  if (!request) return null
  return {
    request,
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
  const receiptEvent = buildCompactNostrIdentityDeviceApprovalReceiptEvent({
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

const encodeCompactNostrIdentityChatDeviceApprovalRequest = (
  request: LocalNostrIdentityDeviceApprovalRequest
): string =>
  `${NOSTR_IDENTITY_CHAT_DEVICE_APPROVAL_PREFIX}${request.deviceAppKeyPubkey}.${hexFromBytes(
    request.requestSecretKey
  )}`

const parseCompactNostrIdentityChatDeviceApprovalRequest = (
  input: string
): NostrIdentityDeviceApprovalRequest | null => {
  const cleaned = cleanNostrPrefix(input)
  if (!cleaned.startsWith(NOSTR_IDENTITY_CHAT_DEVICE_APPROVAL_PREFIX)) return null
  const payload = cleaned.slice(NOSTR_IDENTITY_CHAT_DEVICE_APPROVAL_PREFIX.length)
  const parts = payload.split('.')
  if (parts.length !== 2) return null
  const [deviceAppKeyPubkey, requestSecretKeyHex] = parts
  if (!isHexSecret(deviceAppKeyPubkey) || !isHexSecret(requestSecretKeyHex)) return null
  const requestSecretKey = bytesFromHex(requestSecretKeyHex)
  return {
    requestPubkey: getPublicKey(requestSecretKey),
    deviceAppKeyPubkey: deviceAppKeyPubkey.toLowerCase(),
    requestSecret: requestSecretKeyHex.toLowerCase(),
    deviceAppKeyProof: '',
    requestedAt: currentUnixSeconds(),
  }
}

const buildCompactNostrIdentityDeviceApprovalReceiptEvent = (options: {
  signerSecretKey: Uint8Array
  request: NostrIdentityDeviceApprovalRequest
  profileId: string
  approvedAt: number
  subjectPubkey?: string
  rosterOpEvent?: Event | SignedNostrIdentityRosterOp
}): Event => {
  const approvedByPubkey = getPublicKey(options.signerSecretKey)
  const signedRosterEvent =
    options.rosterOpEvent !== undefined
      ? signedRosterOpEventJson(options.rosterOpEvent)
      : undefined
  const rosterOpId =
    signedRosterEvent !== undefined
      ? parseNostrIdentityRosterOpEvent(JSON.parse(signedRosterEvent) as Event).op_id
      : undefined
  const receipt: NostrIdentityDeviceApprovalReceipt = {
    schema: NOSTR_IDENTITY_DEVICE_APPROVAL_RECEIPT_SCHEMA,
    profileId: options.profileId,
    requestPubkey: options.request.requestPubkey,
    deviceAppKeyPubkey: options.request.deviceAppKeyPubkey,
    approvedByPubkey,
    approvedAt: options.approvedAt,
    requestSecret: options.request.requestSecret,
    ...(options.subjectPubkey ? { subjectPubkey: options.subjectPubkey } : {}),
    ...(rosterOpId ? { rosterOpId } : {}),
    ...(signedRosterEvent ? { signedRosterEvent } : {}),
  }
  const conversationKey = nip44.v2.utils.getConversationKey(
    options.signerSecretKey,
    receipt.requestPubkey
  )
  return finalizeEvent(
    {
      kind: FACT_OP_KIND,
      content: nip44.v2.encrypt(JSON.stringify(receipt), conversationKey),
      created_at: receipt.approvedAt,
      tags: [
        ['type', NOSTR_IDENTITY_DEVICE_APPROVAL_RECEIPT_TYPE],
        ['p', receipt.requestPubkey],
        ['i', receipt.profileId, 'subject'],
      ],
    },
    options.signerSecretKey
  )
}

const signedRosterOpEventJson = (rosterOpEvent: Event | SignedNostrIdentityRosterOp): string =>
  'event_json' in rosterOpEvent ? rosterOpEvent.event_json : JSON.stringify(rosterOpEvent)

const cleanNostrPrefix = (input: string): string => {
  const trimmed = input.trim()
  return trimmed.toLowerCase().startsWith('nostr:') ? trimmed.slice('nostr:'.length) : trimmed
}

const isHexSecret = (value: string): boolean => /^[0-9a-f]{64}$/i.test(value)

const hexFromBytes = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

const bytesFromHex = (hex: string): Uint8Array => {
  if (!isHexSecret(hex)) throw new Error('Invalid hex secret')
  const bytes = new Uint8Array(32)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

const currentUnixSeconds = (): number => Math.round(Date.now() / 1000)

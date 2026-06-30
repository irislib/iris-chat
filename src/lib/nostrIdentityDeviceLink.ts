import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  nip44,
  type Event,
} from 'nostr-tools'
import { Invite } from 'nostr-double-ratchet'
import { utils as secpUtils } from '@noble/secp256k1'
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

export const createNdrLinkInviteForDeviceApprovalRequest = (
  request: NostrIdentityDeviceApprovalRequest
): Invite => {
  if (!isHexSecret(request.deviceAppKeyPubkey) || !isHexSecret(request.requestSecret)) {
    throw new Error('Invalid compact link request')
  }
  const rng = new StdRngCompat(bytesFromHex(request.requestSecret))
  const inviterEphemeralPrivateKey = rng.nextSecretKey()
  const sharedSecret = hexFromBytes(rng.nextSecretKey())
  const deviceAppKeyPubkey = request.deviceAppKeyPubkey.toLowerCase()
  return new Invite(
    getPublicKey(inviterEphemeralPrivateKey),
    sharedSecret,
    deviceAppKeyPubkey,
    inviterEphemeralPrivateKey,
    deviceAppKeyPubkey,
    1,
    [],
    0,
    'link'
  )
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
  `${request.deviceAppKeyPubkey}.${hexFromBytes(request.requestSecretKey)}`

const parseCompactNostrIdentityChatDeviceApprovalRequest = (
  input: string
): NostrIdentityDeviceApprovalRequest | null => {
  const parts = input.trim().split('.')
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

class StdRngCompat {
  private readonly seed: Uint8Array
  private blockCounter = 0n
  private buffer = new Uint8Array()
  private offset = 0

  constructor(seed: Uint8Array) {
    if (seed.length !== 32) throw new Error('StdRng seed must be 32 bytes')
    this.seed = seed
  }

  nextSecretKey(): Uint8Array {
    for (let attempts = 0; attempts < 16; attempts += 1) {
      const candidate = this.nextBytes(32)
      if (secpUtils.isValidSecretKey(candidate)) return candidate
    }
    throw new Error('Could not derive a valid deterministic link key')
  }

  private nextBytes(length: number): Uint8Array {
    const output = new Uint8Array(length)
    let written = 0
    while (written < length) {
      if (this.offset >= this.buffer.length) {
        this.buffer = this.nextBlock()
        this.offset = 0
      }
      const take = Math.min(length - written, this.buffer.length - this.offset)
      output.set(this.buffer.slice(this.offset, this.offset + take), written)
      this.offset += take
      written += take
    }
    return output
  }

  private nextBlock(): Uint8Array<ArrayBuffer> {
    const block = chachaBlock(this.seed, this.blockCounter, 12)
    this.blockCounter += 1n
    return block
  }
}

const chachaBlock = (
  key: Uint8Array,
  counter: bigint,
  rounds: number
): Uint8Array<ArrayBuffer> => {
  const state = new Uint32Array(16)
  state[0] = 0x61707865
  state[1] = 0x3320646e
  state[2] = 0x79622d32
  state[3] = 0x6b206574
  for (let index = 0; index < 8; index += 1) {
    state[4 + index] = readU32Le(key, index * 4)
  }
  state[12] = Number(counter & 0xffffffffn) >>> 0
  state[13] = Number((counter >> 32n) & 0xffffffffn) >>> 0
  state[14] = 0
  state[15] = 0

  const working = new Uint32Array(state)
  for (let index = 0; index < rounds / 2; index += 1) {
    quarterRound(working, 0, 4, 8, 12)
    quarterRound(working, 1, 5, 9, 13)
    quarterRound(working, 2, 6, 10, 14)
    quarterRound(working, 3, 7, 11, 15)
    quarterRound(working, 0, 5, 10, 15)
    quarterRound(working, 1, 6, 11, 12)
    quarterRound(working, 2, 7, 8, 13)
    quarterRound(working, 3, 4, 9, 14)
  }

  const output = new Uint8Array(64)
  for (let index = 0; index < 16; index += 1) {
    writeU32Le(output, index * 4, (working[index] + state[index]) >>> 0)
  }
  return output
}

const quarterRound = (
  state: Uint32Array,
  a: number,
  b: number,
  c: number,
  d: number
): void => {
  state[a] = (state[a] + state[b]) >>> 0
  state[d] = rotateLeft((state[d] ^ state[a]) >>> 0, 16)
  state[c] = (state[c] + state[d]) >>> 0
  state[b] = rotateLeft((state[b] ^ state[c]) >>> 0, 12)
  state[a] = (state[a] + state[b]) >>> 0
  state[d] = rotateLeft((state[d] ^ state[a]) >>> 0, 8)
  state[c] = (state[c] + state[d]) >>> 0
  state[b] = rotateLeft((state[b] ^ state[c]) >>> 0, 7)
}

const rotateLeft = (value: number, shift: number): number =>
  ((value << shift) | (value >>> (32 - shift))) >>> 0

const readU32Le = (bytes: Uint8Array, offset: number): number =>
  (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0

const writeU32Le = (bytes: Uint8Array, offset: number, value: number): void => {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
  bytes[offset + 2] = (value >>> 16) & 0xff
  bytes[offset + 3] = (value >>> 24) & 0xff
}

const currentUnixSeconds = (): number => Math.round(Date.now() / 1000)

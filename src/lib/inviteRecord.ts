import { decryptChk, encryptChk, sha256, nhashEncode, nhashDecode } from '@hashtree/core'

// A private hashtree file consisting of one CHK-encrypted leaf. No public form.
export const MAX_INVITE_BYTES = 16 * 1024
export interface InviteRecord {
  v: 1
  type: 'personal' | 'group'
  name: string
  nonce: string
  invite: { version: 2; inviter: string; ephemeralKey: string; sharedSecret: string; owner: string; deviceId?: string; purpose?: string }
  groupId?: string
  token?: string
  expiresAt?: number
  maxUses?: number
}
const hexKey = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

export function validateInviteRecord(value: unknown): InviteRecord {
  const r = value as InviteRecord
  if (!r || r.v !== 1 || !['personal', 'group'].includes(r.type) ||
    typeof r.name !== 'string' || r.name.length > 100 || !hexKey(r.nonce) ||
    !r.invite || r.invite.version !== 2 || ![r.invite.inviter, r.invite.ephemeralKey, r.invite.sharedSecret, r.invite.owner].every(hexKey) ||
    (r.invite.purpose !== undefined && !['chat', 'private'].includes(r.invite.purpose)) ||
    Object.keys(r.invite).some(k => !['version', 'inviter', 'ephemeralKey', 'sharedSecret', 'owner', 'deviceId', 'purpose'].includes(k)) ||
    Object.keys(r).some(k => !['v', 'type', 'name', 'nonce', 'invite', 'groupId', 'token', 'expiresAt', 'maxUses'].includes(k)) ||
    (r.expiresAt !== undefined && (!Number.isSafeInteger(r.expiresAt) || r.expiresAt <= 0)) ||
    (r.maxUses !== undefined && (!Number.isSafeInteger(r.maxUses) || r.maxUses < 1 || r.maxUses > 10000)) ||
    (r.type === 'group' && (typeof r.groupId !== 'string' || !r.groupId || r.groupId.length > 128 || !hexKey(r.token))) ||
    (r.type === 'personal' && (r.groupId !== undefined || r.token !== undefined || r.maxUses !== undefined)) ||
    (r.invite.deviceId !== undefined && (typeof r.invite.deviceId !== 'string' || r.invite.deviceId.length > 128))) {
    throw new Error('Invalid invite record')
  }
  return r
}

export function encodeInviteReference(cid: { hash: Uint8Array; key: Uint8Array }): string {
  if (cid.hash.length !== 32 || cid.key.length !== 32) throw new Error('Invalid private invite reference')
  return nhashEncode(cid)
}

export function decodeInviteReference(reference: string): { hash: Uint8Array; key: Uint8Array } {
  if (!reference.startsWith('nhash1') || reference.length > 160) throw new Error('Invalid private invite reference')
  const cid = nhashDecode(reference)
  if (!cid.key || cid.hash.length !== 32 || cid.key.length !== 32 || nhashEncode(cid) !== reference) {
    throw new Error('Invalid private invite reference')
  }
  return { hash: cid.hash, key: cid.key }
}

export async function encodeInviteRecord(record: InviteRecord): Promise<{ reference: string; ciphertext: Uint8Array }> {
  validateInviteRecord(record)
  const plaintext = new TextEncoder().encode(JSON.stringify(record))
  if (plaintext.length + 16 > MAX_INVITE_BYTES) throw new Error('Invite is too large')
  const { ciphertext, key } = await encryptChk(plaintext)
  return { reference: encodeInviteReference({ hash: await sha256(ciphertext), key }), ciphertext }
}

export async function decodeInviteRecord(reference: string, ciphertext: Uint8Array): Promise<InviteRecord> {
  const { hash, key } = decodeInviteReference(reference)
  if (ciphertext.length > MAX_INVITE_BYTES || ciphertext.length < 16 ||
    !(await sha256(ciphertext)).every((byte, i) => byte === hash[i])) throw new Error('Invalid invite record')
  return validateInviteRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await decryptChk(ciphertext, key))))
}

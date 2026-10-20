import { describe, expect, it } from 'vitest'
import { encryptChk, sha256 } from '@hashtree/core'
import { encodeInviteReference, decodeInviteReference, encodeInviteRecord, decodeInviteRecord, type InviteRecord } from './inviteRecord'

import fixture from './test-fixtures/private-invite-v1.json'

const record: InviteRecord = { v: 1, type: 'personal', name: 'Alice', nonce: 'a'.repeat(64), invite: {
  version: 2, inviter: 'b'.repeat(64), ephemeralKey: 'c'.repeat(64), sharedSecret: 'd'.repeat(64), owner: 'e'.repeat(64), purpose: 'chat',
} }

describe('private invite records', () => {
  it('matches the shared TypeScript and Rust wire fixture exactly', async () => {
    const encoded = await encodeInviteRecord(fixture.record as InviteRecord)
    expect(encoded.reference).toBe(fixture.reference)
    expect(Array.from(encoded.ciphertext, b => b.toString(16).padStart(2, '0')).join('')).toBe(fixture.ciphertext)
  })
  it('round trips a standard encrypted hashtree leaf through a standard encrypted nhash reference', async () => {
    const { reference, ciphertext } = await encodeInviteRecord(record)
    expect(reference).toMatch(/^nhash1/)
    expect(await decodeInviteRecord(reference, ciphertext)).toEqual(record)
    const cid = decodeInviteReference(reference)
    expect(encodeInviteReference(cid)).toBe(reference)
    expect(cid.hash).toEqual(await sha256(ciphertext))
    expect(new TextDecoder().decode(ciphertext)).not.toContain('Alice')
  })
  it('rejects tampered content, wrong keys and noncanonical references', async () => {
    const { reference, ciphertext } = await encodeInviteRecord(record)
    const corrupt = ciphertext.slice(); corrupt[0] ^= 1
    await expect(decodeInviteRecord(reference, corrupt)).rejects.toThrow()
    const cid = decodeInviteReference(reference); cid.key[0] ^= 1
    await expect(decodeInviteRecord(encodeInviteReference(cid), ciphertext)).rejects.toThrow()
    for (const ref of ['', 'a'.repeat(43), reference + '=', 'A'.repeat(85) + 'B']) expect(() => decodeInviteReference(ref)).toThrow()
  })
  it('rejects public, unsupported, oversized and malformed records', async () => {
    for (const invalid of [{ ...record, v: 2 }, { ...record, invite: { ...record.invite, sharedSecret: '' } },
      { ...record, invite: { ...record.invite, version: undefined } }, { ...record, invite: { ...record.invite, version: 1 } },
      { ...record, nonce: '' }, { ...record, name: 'a'.repeat(101) }, { ...record, type: 'group' },
      { ...record, expiresAt: -1 }, { ...record, maxUses: 0 }]) {
      const { key, ciphertext } = await encryptChk(new TextEncoder().encode(JSON.stringify(invalid)))
      const ref = encodeInviteReference({ hash: await sha256(ciphertext), key })
      await expect(decodeInviteRecord(ref, ciphertext)).rejects.toThrow()
    }
    await expect(decodeInviteRecord('A'.repeat(86), new Uint8Array(16385))).rejects.toThrow()
  })
  it('keeps group keys out of the admission record', async () => {
    const group: InviteRecord = { ...record, type: 'group', groupId: 'group-one', token: 'f'.repeat(64), maxUses: 3, expiresAt: 2000000000 }
    const encoded = await encodeInviteRecord(group)
    expect(await decodeInviteRecord(encoded.reference, encoded.ciphertext)).toEqual(group)
    await expect(encodeInviteRecord({ ...group, secret: 'a'.repeat(64) } as InviteRecord)).rejects.toThrow()
  })
})

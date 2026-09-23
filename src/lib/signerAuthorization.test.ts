import { describe, expect, it } from 'vitest'
import { AppKeys } from 'nostr-double-ratchet'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'
import { prepareSignerAuthorization, selectSignerRoster, validateSignerAuthorization } from './signerAuthorization'

const secret = generateSecretKey()
const owner = getPublicKey(secret)
const oldDevice = getPublicKey(generateSecretKey())
const newDevice = getPublicKey(generateSecretKey())
const now = Math.floor(Date.now() / 1000)
const roster = (createdAt = now - 1, device = oldDevice) => finalizeEvent(new AppKeys([{ identityPubkey: device, createdAt: 123 }]).getEvent({ ownerPubkey: owner, createdAt }), secret)

describe('one-time signer authorization', () => {
  it('preserves existing devices and every opaque label tag', () => {
    const original = roster()
    const previous = finalizeEvent({ ...original, tags: [...original.tags, ['encrypted_device_labels', 'opaque-one'], ['encrypted_device_labels', 'opaque-two']] }, secret)
    const expected = prepareSignerAuthorization(owner, newDevice, previous)
    expect(expected.created_at).toBeGreaterThan(previous.created_at)
    expect(expected.tags.filter(tag => tag[0] === 'encrypted_device_labels')).toEqual(previous.tags.filter(tag => tag[0] === 'encrypted_device_labels'))
    const approved = validateSignerAuthorization(expected, finalizeEvent(expected, secret))
    expect(AppKeys.fromEvent(approved).getAllDevices()).toEqual(expect.arrayContaining([
      { identityPubkey: oldDevice, createdAt: 123 },
      { identityPubkey: newDevice, createdAt: now },
    ]))
  })

  it('rejects a valid signature over changed fields or the wrong identity', () => {
    const expected = prepareSignerAuthorization(owner, newDevice, roster())
    expect(() => validateSignerAuthorization(expected, finalizeEvent({ ...expected, content: 'changed' }, secret))).toThrow('changed')
    expect(() => validateSignerAuthorization(expected, finalizeEvent({ ...expected }, generateSecretKey()))).toThrow('changed')
    const bad = JSON.parse(JSON.stringify(finalizeEvent(expected, secret)))
    bad.sig = '0'.repeat(128)
    expect(() => validateSignerAuthorization(expected, bad)).toThrow('signature')
  })

  it('selects the newest fully verified snapshot and deduplicates relay echoes', () => {
    const previous = roster(now - 2)
    const current = roster(now - 1, newDevice)
    expect(selectSignerRoster([current, previous, current], owner)?.id).toBe(current.id)
    expect(selectSignerRoster([], owner)).toBeNull()
  })

  it('fails closed on competing same-time rosters, future dates, and malformed devices', () => {
    expect(() => selectSignerRoster([roster(now), roster(now, newDevice)], owner)).toThrow('Conflicting')
    expect(() => selectSignerRoster([roster(now + 301)], owner)).toThrow('Invalid')
    const bad = roster()
    bad.tags = bad.tags.map(tag => tag[0] === 'device' ? ['device', 'broken', '123'] : tag)
    expect(() => selectSignerRoster([finalizeEvent(bad, secret)], owner)).toThrow('Invalid')
  })
})

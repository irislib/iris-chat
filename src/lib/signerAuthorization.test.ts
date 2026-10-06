import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppKeys } from 'nostr-double-ratchet'
import { finalizeEvent, generateSecretKey, getPublicKey, verifiedSymbol, type Event } from 'nostr-tools'
import { fetchSignerRoster, prepareSignerAuthorization, selectSignerRoster, validateSignerAuthorization } from './signerAuthorization'
import type { SignerRuntime } from './remoteSigner'

const secret = generateSecretKey()
const owner = getPublicKey(secret)
const oldDevice = getPublicKey(generateSecretKey())
const newDevice = getPublicKey(generateSecretKey())
const now = Math.floor(Date.now() / 1000)
const roster = (createdAt = now - 1, device = oldDevice) => finalizeEvent(new AppKeys([{ identityPubkey: device, createdAt: 123 }]).getEvent({ ownerPubkey: owner, createdAt }), secret)
function freezeEvent<T extends Event>(event: T): T {
  event.tags.forEach(tag => Object.freeze(tag))
  Object.freeze(event.tags)
  Object.freeze(event)
  return event
}

beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(now * 1000) })
afterEach(() => { vi.restoreAllMocks() })

describe('one-time signer authorization', () => {
  it('uses verified responses during outages without hiding partial newer or conflicting heads', async () => {
    const old = roster(now - 2), latest = roster(now - 1, newDevice)
    let events: Event[] = [old]
    let sources = [{ id: 'live', complete: true }, { id: 'unavailable', complete: false }]
    const runtime = { query: async () => ({ events, sources, complete: false }) } as unknown as SignerRuntime
    const lookup = () => fetchSignerRoster(owner, ['wss://live.example', 'wss://offline.example'], new AbortController().signal, runtime)
    expect((await lookup())?.id).toBe(old.id)
    events = [old, latest]
    expect((await lookup())?.id).toBe(latest.id)
    events = [latest, roster(now - 1)]
    await expect(lookup()).rejects.toThrow('Conflicting')
    events = [{ ...old, sig: '0'.repeat(128) }]
    await expect(lookup()).rejects.toThrow('signature')
    events = []
    await expect(lookup()).rejects.toThrow('Could not check')
    events = [latest]
    sources = sources.map(source => ({ ...source, complete: false }))
    await expect(lookup()).rejects.toThrow('Could not check')
  })
  it('preserves existing devices without copying old static-encrypted names', () => {
    const original = roster()
    const previous = finalizeEvent({ ...original, tags: [...original.tags, ['encrypted_device_labels', 'opaque-one'], ['encrypted_device_labels', 'opaque-two']] }, secret)
    const expected = prepareSignerAuthorization(owner, newDevice, previous)
    expect(expected.created_at).toBeGreaterThan(previous.created_at)
    expect(expected.tags.some(tag => tag[0] === 'encrypted_device_labels')).toBe(false)
    expect(expected.tags.some(tag => tag[0] === 'f' && tag[1] === 'encrypted_device_labels')).toBe(false)
    expect(previous.tags.filter(tag => tag[0] === 'encrypted_device_labels')).toHaveLength(2)
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

  it('verifies frozen relay and signer events without changing their ownership', () => {
    const previous = freezeEvent(roster())
    const selected = selectSignerRoster([previous], owner)
    expect(selected?.id).toBe(previous.id)
    expect(selected).not.toBe(previous)
    expect(selected?.tags).not.toBe(previous.tags)
    const expected = prepareSignerAuthorization(owner, newDevice, previous)
    const signed = freezeEvent(finalizeEvent(expected, secret))
    const approved = validateSignerAuthorization(expected, signed)
    expect(approved.id).toBe(signed.id)
    expect(approved).not.toBe(signed)
    expect(previous.tags.filter(tag => tag[0] === 'device')).toHaveLength(1)
    expect(Object.isFrozen(previous)).toBe(true)
    expect(Object.isFrozen(signed)).toBe(true)
  })

  it('rejects invalid signatures even when frozen inputs carry cached verification flags', () => {
    const previous = freezeEvent({ ...roster(), sig: '0'.repeat(128), [verifiedSymbol]: true as const })
    expect(() => selectSignerRoster([previous], owner)).toThrow(/signature/)
    expect(() => prepareSignerAuthorization(owner, newDevice, previous)).toThrow(/signature/)
    const expected = prepareSignerAuthorization(owner, newDevice, null)
    const signed = freezeEvent({ ...finalizeEvent(expected, secret), sig: '0'.repeat(128), [verifiedSymbol]: true as const })
    expect(() => validateSignerAuthorization(expected, signed)).toThrow('Invalid signer signature.')
  })

  it('fails closed on competing same-time rosters, future dates, and malformed devices', () => {
    expect(() => selectSignerRoster([roster(now), roster(now, newDevice)], owner)).toThrow('Conflicting')
    expect(() => selectSignerRoster([roster(now + 301)], owner)).toThrow('Invalid')
    const bad = roster()
    bad.tags = bad.tags.map(tag => tag[0] === 'device' ? ['device', 'broken', '123'] : tag)
    expect(() => selectSignerRoster([finalizeEvent(bad, secret)], owner)).toThrow('Invalid')
  })
})

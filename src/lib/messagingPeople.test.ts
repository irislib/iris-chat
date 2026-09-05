// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'
import { AppKeys, type NostrSubscribe } from 'nostr-double-ratchet'
import { createMessagingPeopleStore, type MessagingPeopleState, type MessagingSupportEvent } from './messagingPeople'

const owner = generateSecretKey()
const ownerKey = getPublicKey(owner)
const device = getPublicKey(generateSecretKey())
const now = Math.floor(Date.now() / 1000)
function event(devices = [device], time = now): MessagingSupportEvent {
  return finalizeEvent(new AppKeys(devices.map(identityPubkey => ({ identityPubkey, createdAt: time }))).getEvent({
    ownerPrivateKey: owner, ownerPubkey: ownerKey,
    profileId: '123e4567-e89b-42d3-a456-426614174000', createdAt: time,
  }), owner)
}
function observe(initialEvents: MessagingSupportEvent[] = []) {
  let emit: Parameters<NostrSubscribe>[1] = () => {}
  let state!: MessagingPeopleState
  const stop = vi.fn()
  const unsubscribe = createMessagingPeopleStore([ownerKey], {
    initialEvents, subscribe: (_filter, callback) => { emit = callback; return stop },
  }).subscribe(value => { state = value })
  return { emit: (value: MessagingSupportEvent) => emit(value), current: () => state, unsubscribe, stop }
}

describe('messaging people', () => {
  it('hides unknown users and shows only a verified nonempty device list', () => {
    const store = observe()
    expect(store.current().events.size).toBe(0)
    store.emit(event())
    expect(store.current().events.has(ownerKey)).toBe(true)
    store.unsubscribe()
    expect(store.stop).toHaveBeenCalledOnce()
    store.emit(event([], now + 1))
    expect(store.current().events.has(ownerKey)).toBe(true)
  })
  it('restores verified results offline and applies revocations without stale resurrection', () => {
    const store = observe([event()])
    expect(store.current().events.has(ownerKey)).toBe(true)
    store.emit(event([], now + 1))
    expect(store.current().events.size).toBe(0)
    store.emit(event())
    expect(store.current().events.size).toBe(0)
    store.unsubscribe()
  })
  it('rejects forged, future and conflicting snapshots including cached conflicts', () => {
    const forged = { ...JSON.parse(JSON.stringify(event())), sig: '0'.repeat(128) }
    const store = observe([forged, event([device], now + 3600)])
    expect(store.current().events.size).toBe(0)
    const first = event()
    const conflict = event([getPublicKey(generateSecretKey())])
    store.emit(first)
    store.emit(conflict)
    expect(store.current().events.size).toBe(0)
    store.unsubscribe()
    const restored = observe([first, conflict])
    expect(restored.current().events.size).toBe(0)
    restored.unsubscribe()
  })
  it('finishes loading on timeout without making an unknown user eligible', () => {
    vi.useFakeTimers()
    const store = observe()
    expect(store.current().loading).toBe(true)
    vi.advanceTimersByTime(5000)
    expect(store.current()).toEqual({ events: new Map(), loading: false })
    store.unsubscribe()
    vi.useRealTimers()
  })
})

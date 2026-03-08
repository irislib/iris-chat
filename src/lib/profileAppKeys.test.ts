import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceEntry, NostrSubscribe } from 'nostr-double-ratchet'
import { createProfileAppKeysStore } from './profileAppKeys'

type SubscribedEvent = Parameters<NostrSubscribe>[1] extends (event: infer E) => void ? E : never

const PROFILE_PUBKEY = '989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f'
const SIGNED_APP_KEYS_EVENT = {
  kind: 30078,
  pubkey: PROFILE_PUBKEY,
  content: '',
  created_at: 1700000002,
  tags: [
    ['d', 'double-ratchet/app-keys'],
    ['version', '1'],
    ['device', 'b'.repeat(64), '1700000000'],
    ['device', 'c'.repeat(64), '1700000001'],
  ],
  id: '905df67b79e7fa7a485eb5e090b342c9fb4913e4f559d74a74f992ccb9125e72',
  sig: '2f34a8eb9691c2493e1fa4fd188fe71c43d136f8a9423fa501db6a014f015cb06875c0074f847c2bc4797c84c89c702ec53e9515764ce8b72899ece3213ceafc',
} as SubscribedEvent
const observeStore = <T>(store: { subscribe: (run: (value: T) => void) => () => void }) => {
  let current: T
  const unsubscribe = store.subscribe((value) => {
    current = value
  })

  return {
    current: () => current,
    unsubscribe,
  }
}

const createSubscribeHarness = () => {
  let onEvent: ((event: SubscribedEvent) => void) | null = null
  const stop = vi.fn()

  const subscribe: NostrSubscribe = (filter, callback) => {
    expect(filter).toEqual({
      kinds: [30078],
      authors: [PROFILE_PUBKEY],
      '#d': ['double-ratchet/app-keys'],
    })
    onEvent = callback
    return stop
  }

  return {
    emit(event = SIGNED_APP_KEYS_EVENT) {
      onEvent?.(event)
    },
    stop,
    subscribe,
  }
}

describe('profileAppKeys', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads device pubkeys from a signed AppKeys event', () => {
    const harness = createSubscribeHarness()
    const observer = observeStore(
      createProfileAppKeysStore(PROFILE_PUBKEY, {
        subscribe: harness.subscribe,
        timeoutMs: 3000,
      })
    )

    expect(observer.current()).toEqual({
      devices: [],
      loading: true,
    })

    const devices: DeviceEntry[] = [
      {
        identityPubkey: 'b'.repeat(64),
        createdAt: 1700000000,
      },
      {
        identityPubkey: 'c'.repeat(64),
        createdAt: 1700000001,
      },
    ]

    harness.emit()

    expect(observer.current()).toEqual({
      devices,
      loading: false,
    })

    observer.unsubscribe()
    expect(harness.stop).toHaveBeenCalledTimes(1)
  })

  it('settles to an empty state when no AppKeys arrive before the timeout', () => {
    const harness = createSubscribeHarness()
    const observer = observeStore(
      createProfileAppKeysStore(PROFILE_PUBKEY, {
        subscribe: harness.subscribe,
        timeoutMs: 3000,
      })
    )

    vi.advanceTimersByTime(3000)

    expect(observer.current()).toEqual({
      devices: [],
      loading: false,
    })

    observer.unsubscribe()
    expect(harness.stop).toHaveBeenCalledTimes(1)
  })

  it('keeps any already-known devices visible while refreshing relays', () => {
    const harness = createSubscribeHarness()
    const initialDevices: DeviceEntry[] = [
      {
        identityPubkey: 'd'.repeat(64),
        createdAt: 1700000100,
      },
    ]

    const observer = observeStore(
      createProfileAppKeysStore(PROFILE_PUBKEY, {
        subscribe: harness.subscribe,
        timeoutMs: 3000,
        initialDevices,
      })
    )

    expect(observer.current()).toEqual({
      devices: initialDevices,
      loading: true,
    })

    vi.advanceTimersByTime(3000)

    expect(observer.current()).toEqual({
      devices: initialDevices,
      loading: false,
    })

    observer.unsubscribe()
  })
})

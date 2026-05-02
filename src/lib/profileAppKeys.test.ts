import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceEntry, NostrSubscribe } from 'nostr-double-ratchet'
import { createProfileAppKeysStore } from './profileAppKeys'

type SubscribedEvent = Parameters<NostrSubscribe>[1] extends (event: infer E) => void ? E : never

const PROFILE_PUBKEY = '989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f'
const OWNER_WITH_LABELS_PUBKEY = '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f'
const OWNER_WITH_LABELS_PRIVATE_KEY = new Uint8Array(32).fill(1)
const LABELED_APP_KEYS_EVENT = {
  kind: 30078,
  pubkey: OWNER_WITH_LABELS_PUBKEY,
  content:
    'AqHiWDdVvtFfJjxO3hFhaVy37sgyc0cnqbzx0L/EmoVt9BUidcy4ATCfFlrenoO9jnNRoSv5F0l9rfTJKRlgBM/2KS6Qiwrtb2VaCIMszzbsXTfI+sm3Ga1t0sz2LK2vH5Yt3iGpqJGySm84xZ6MPtl7HGcNENu65g1V0zi5hjaOViKLL6Fhv0IatgbFjNvuZPUv0qXZW9ZMMW4yXbQOnL4991n/maSf/WLJuvenVaox3GPK+SqvEMzCGbHYXUD2AudgO+setHGl7tFClhWUE/y/DfFRcpU4+JwtQCSs3Xjat6M+sjYELqW8us/5R9uLKdHmHkIurCyADqKKkVblrZPnVm0ryM7NXte5zCyFJNgD/iaq6eMaHIbXzy45+vxVrjbZ',
  created_at: 1700000004,
  tags: [
    ['d', 'double-ratchet/app-keys'],
    ['version', '1'],
    ['device', 'b'.repeat(64), '1700000000'],
  ],
  id: 'ef6e8118faaf7140c3ca6e79e9cb62fa83a5ca5a624072cc798217fb17a2b407',
  sig: '38bea24b32ff6fa48a33e945aa1df77651213770a2ddaa0c0bd8a5a6e2cdaf492da12727cdb68fe612f939ef651f3dda884dd5c8513c93f657c123f57efab579',
} as SubscribedEvent
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

const createSubscribeHarness = (pubkey = PROFILE_PUBKEY) => {
  let onEvent: ((event: SubscribedEvent) => void) | null = null
  const stop = vi.fn()

  const subscribe: NostrSubscribe = (filter, callback) => {
    expect(filter).toEqual({
      kinds: [30078],
      authors: [pubkey],
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

  it('loads encrypted device labels when the owner key is available', () => {
    const devicePubkey = 'b'.repeat(64)
    const harness = createSubscribeHarness(OWNER_WITH_LABELS_PUBKEY)
    const observer = observeStore(
      createProfileAppKeysStore(OWNER_WITH_LABELS_PUBKEY, {
        subscribe: harness.subscribe,
        timeoutMs: 3000,
        ownerPrivateKey: OWNER_WITH_LABELS_PRIVATE_KEY,
      })
    )

    harness.emit(LABELED_APP_KEYS_EVENT)

    expect(observer.current()).toEqual({
      devices: [
        {
          identityPubkey: devicePubkey,
          createdAt: 1700000000,
          labels: {
            deviceLabel: 'Safari on Mac',
            clientLabel: 'Iris Chat Web',
            updatedAt: 1700000003,
          },
        },
      ],
      loading: false,
    })

    observer.unsubscribe()
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

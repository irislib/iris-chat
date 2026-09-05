// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'
import { AppKeys, buildAppKeysFilter, type NostrSubscribe } from 'nostr-double-ratchet'
import {
  PROFILE_APP_KEYS_KIND,
  PROFILE_APP_KEYS_TYPE,
  createProfileAppKeysStore,
  type ProfileAppKeysState,
} from './profileAppKeys'

type SubscribedEvent = Parameters<NostrSubscribe>[1] extends (event: infer E) => void ? E : never

const PROFILE_ID = '123e4567-e89b-42d3-a456-426614174000'
const DEVICE_PUBKEY = '4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766'

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

const appKeysSnapshot = (
  ownerPrivateKey: Uint8Array,
  devices: Array<{ identityPubkey: string; createdAt: number }>,
  createdAt = 1700000200,
): SubscribedEvent =>
  finalizeEvent(
    new AppKeys(devices).getEvent({
      ownerPrivateKey,
      ownerPubkey: getPublicKey(ownerPrivateKey),
      profileId: PROFILE_ID,
      createdAt,
    }),
    ownerPrivateKey
  ) as unknown as SubscribedEvent

describe('profileAppKeys', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not subscribe when no owner pubkey is available', () => {
    const stop = vi.fn()
    const subscribe = vi.fn(() => stop) as unknown as NostrSubscribe
    const observer = observeStore(
      createProfileAppKeysStore(undefined, {
        subscribe,
        timeoutMs: 3000,
      })
    )

    expect(observer.current()).toEqual({
      devices: [],
      loading: false,
    } satisfies ProfileAppKeysState)
    expect(subscribe).not.toHaveBeenCalled()

    observer.unsubscribe()
    expect(stop).not.toHaveBeenCalled()
  })

  it('subscribes to owner AppKeys fact snapshots', () => {
    const ownerPrivateKey = generateSecretKey()
    const ownerPubkey = getPublicKey(ownerPrivateKey)
    let onEvent: ((event: SubscribedEvent) => void) | null = null
    const stop = vi.fn()
    const subscribe: NostrSubscribe = (filter, callback) => {
      expect(filter).toEqual(buildAppKeysFilter(ownerPubkey))
      onEvent = callback
      return stop
    }
    const observer = observeStore(
      createProfileAppKeysStore(ownerPubkey, {
        subscribe,
        timeoutMs: 3000,
      })
    )

    expect(observer.current()).toEqual({
      devices: [],
      loading: true,
    })

    const emit = onEvent as unknown as (event: SubscribedEvent) => void
    emit(appKeysSnapshot(ownerPrivateKey, [{ identityPubkey: DEVICE_PUBKEY, createdAt: 1700000200 }]))

    expect(observer.current()).toEqual({
      devices: [
        {
          identityPubkey: DEVICE_PUBKEY,
          createdAt: 1700000200,
        },
      ],
      loading: false,
    })

    observer.unsubscribe()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('keeps initial devices until a relay snapshot arrives', () => {
    const ownerPrivateKey = generateSecretKey()
    const ownerPubkey = getPublicKey(ownerPrivateKey)
    let onEvent: ((event: SubscribedEvent) => void) | null = null
    const subscribe: NostrSubscribe = (_filter, callback) => {
      onEvent = callback
      return vi.fn()
    }
    const observer = observeStore(
      createProfileAppKeysStore(ownerPubkey, {
        subscribe,
        timeoutMs: 3000,
        initialDevices: [{ identityPubkey: DEVICE_PUBKEY, createdAt: 1 }],
      })
    )

    expect(observer.current()).toEqual({
      devices: [{ identityPubkey: DEVICE_PUBKEY, createdAt: 1 }],
      loading: true,
    })

    const secondDevice = getPublicKey(generateSecretKey())
    const emit = onEvent as unknown as (event: SubscribedEvent) => void
    emit(appKeysSnapshot(ownerPrivateKey, [{ identityPubkey: secondDevice, createdAt: 2 }]))

    expect(observer.current()).toEqual({
      devices: [{ identityPubkey: secondDevice, createdAt: 2 }],
      loading: false,
    })

    observer.unsubscribe()
  })

  it('ignores unrelated or invalid snapshots', () => {
    const ownerPrivateKey = generateSecretKey()
    const ownerPubkey = getPublicKey(ownerPrivateKey)
    let onEvent: ((event: SubscribedEvent) => void) | null = null
    const subscribe: NostrSubscribe = (_filter, callback) => {
      onEvent = callback
      return vi.fn()
    }
    const observer = observeStore(
      createProfileAppKeysStore(ownerPubkey, {
        subscribe,
        timeoutMs: 3000,
      })
    )

    const emit = onEvent as unknown as (event: SubscribedEvent) => void
    emit({
      kind: PROFILE_APP_KEYS_KIND,
      pubkey: ownerPubkey,
      content: '',
      created_at: 1700000202,
      tags: [
        ['d', PROFILE_ID],
        ['i', PROFILE_ID, 'subject'],
        ['type', 'other_fact_type'],
      ],
      id: 'f'.repeat(64),
      sig: '1'.repeat(128),
    } as SubscribedEvent)
    vi.advanceTimersByTime(3000)

    expect(observer.current()).toEqual({
      devices: [],
      loading: false,
    })

    observer.unsubscribe()
  })

  it('exports the canonical roster snapshot kind and type for UI/runtime filters', () => {
    expect(PROFILE_APP_KEYS_KIND).toBe(37368)
    expect(PROFILE_APP_KEYS_TYPE).toBe('app_keys_roster_snapshot')
  })
})


describe('profile device head ordering', () => {
  it('ignores stale device lists and keeps revocations and same-time conflicts hidden', () => {
    const owner = generateSecretKey()
    let emit: Parameters<NostrSubscribe>[1] = () => {}
    const observer = observeStore(createProfileAppKeysStore(getPublicKey(owner), {
      subscribe: (_filter, callback) => { emit = callback; return () => {} },
    }))
    const device = [{ identityPubkey: DEVICE_PUBKEY, createdAt: 1700000200 }]
    emit(appKeysSnapshot(owner, device, 1700000200))
    expect(observer.current().devices).toHaveLength(1)
    emit(appKeysSnapshot(owner, [], 1700000201))
    emit(appKeysSnapshot(owner, device, 1700000200))
    expect(observer.current().devices).toHaveLength(0)
    emit(appKeysSnapshot(owner, device, 1700000201))
    expect(observer.current().devices).toHaveLength(0)
    emit(appKeysSnapshot(owner, device, 1700000202))
    expect(observer.current().devices).toHaveLength(1)
    observer.unsubscribe()
  })
})

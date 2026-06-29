// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IDENTITY_GRAPH_ROSTER_TYPE,
  KIND_NOSTR_IDENTITY_ROSTER_OP,
  type SignedNostrIdentityRosterOp,
} from '@iris/identity/profile'
import type { NostrSubscribe } from 'nostr-double-ratchet'
import {
  createProfileAppKeysStore,
  type ProfileAppKeysState,
} from './profileAppKeys'

type SubscribedEvent = Parameters<NostrSubscribe>[1] extends (event: infer E) => void ? E : never

const PROFILE_PUBKEY = '989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f'
const NOSTR_IDENTITY_ID = '123e4567-e89b-42d3-a456-426614174000'
const ADMIN_PUBKEY = '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f'
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

const rawEvent = (
  op: SignedNostrIdentityRosterOp
): SubscribedEvent => JSON.parse(op.event_json) as SubscribedEvent

const BOOTSTRAP_OP: SignedNostrIdentityRosterOp = {
  op_id: 'd70b9d5e46c655e1381901fe648b89411f4058ca756ae85a877fd741705ac438',
  signer_pubkey: ADMIN_PUBKEY,
  content: {
    schema: 1,
    profile_id: NOSTR_IDENTITY_ID,
    actor_pubkey: ADMIN_PUBKEY,
    client_nonce: 'bootstrap-admin',
    created_at: 1700000200,
    op: {
      op: 'add_facet',
      facet: {
        pubkey: ADMIN_PUBKEY,
        purposes: ['app_key'],
        capabilities: {
          can_write_roots: true,
          can_admin_profile: true,
          can_receive_secret_wraps: true,
          can_decrypt_secret_epochs: true,
        },
        added_at: 1700000200,
      },
    },
  },
  event_json:
    '{"kind":7368,"content":"","created_at":1700000200,"tags":[["i","123e4567-e89b-42d3-a456-426614174000","subject"],["p","1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f"],["actor_pubkey","1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f"],["client_nonce","bootstrap-admin"],["created_at","1700000200"],["key_added_at","1700000200"],["key_capability","admin"],["key_capability","decrypt_secret_epochs"],["key_capability","receive_secret_wraps"],["key_capability","write"],["key_pubkey","1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f"],["key_purpose","app"],["op","add_key"],["schema","1"],["type","nostr_identity_roster_op"]],"pubkey":"1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f","id":"d70b9d5e46c655e1381901fe648b89411f4058ca756ae85a877fd741705ac438","sig":"0e34d0fcfffd581ab8415dfcbd35c84165e7df86c938ce9c893c44ded23246fff02f758f6cfb6c9a4776dadcbc9c7b6505cbfcbb2c2ccf7235e9be0a3bbb76eb"}',
}

const ADD_DEVICE_OP: SignedNostrIdentityRosterOp = {
  op_id: '8f469f52e4e1ec3345ff01177bf2acab049631f151cc04a4957c20da68097966',
  signer_pubkey: ADMIN_PUBKEY,
  content: {
    schema: 1,
    profile_id: NOSTR_IDENTITY_ID,
    actor_pubkey: ADMIN_PUBKEY,
    parents: [BOOTSTRAP_OP.op_id],
    client_nonce: 'add-device',
    created_at: 1700000201,
    op: {
      op: 'add_facet',
      facet: {
        pubkey: DEVICE_PUBKEY,
        purposes: ['app_key'],
        capabilities: {
          can_write_roots: true,
          can_receive_secret_wraps: true,
          can_decrypt_secret_epochs: true,
        },
        added_at: 1700000201,
      },
    },
  },
  event_json:
    '{"kind":7368,"content":"","created_at":1700000201,"tags":[["i","123e4567-e89b-42d3-a456-426614174000","subject"],["e","d70b9d5e46c655e1381901fe648b89411f4058ca756ae85a877fd741705ac438","","prev"],["p","1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f"],["p","4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766"],["actor_pubkey","1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f"],["client_nonce","add-device"],["created_at","1700000201"],["key_added_at","1700000201"],["key_capability","decrypt_secret_epochs"],["key_capability","receive_secret_wraps"],["key_capability","write"],["key_pubkey","4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766"],["key_purpose","app"],["op","add_key"],["schema","1"],["type","nostr_identity_roster_op"]],"pubkey":"1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f","id":"8f469f52e4e1ec3345ff01177bf2acab049631f151cc04a4957c20da68097966","sig":"d13fa19fd56af1ddb2b2e7f56960daad00a314b322159ce8fe2c5cb809210c21a1d60627b779012efe9ecc6c8c0562bdb643e1231b635173f54761773aef6654"}',
}

const REMOVE_DEVICE_OP: SignedNostrIdentityRosterOp = {
  op_id: 'e3838286c5e78095247a144b4744c3c0636bf150633b3ad727f1d73f5219c703',
  signer_pubkey: ADMIN_PUBKEY,
  content: {
    schema: 1,
    profile_id: NOSTR_IDENTITY_ID,
    actor_pubkey: ADMIN_PUBKEY,
    parents: [ADD_DEVICE_OP.op_id, BOOTSTRAP_OP.op_id],
    client_nonce: 'remove-device',
    created_at: 1700000202,
    op: {
      op: 'tombstone_facet',
      pubkey: DEVICE_PUBKEY,
      reason: 'removed',
    },
  },
  event_json:
    '{"kind":7368,"content":"","created_at":1700000202,"tags":[["i","123e4567-e89b-42d3-a456-426614174000","subject"],["e","8f469f52e4e1ec3345ff01177bf2acab049631f151cc04a4957c20da68097966","","prev"],["e","d70b9d5e46c655e1381901fe648b89411f4058ca756ae85a877fd741705ac438","","prev"],["p","1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f"],["p","4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766"],["actor_pubkey","1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f"],["client_nonce","remove-device"],["created_at","1700000202"],["op","tombstone_key"],["reason","removed"],["schema","1"],["target_pubkey","4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766"],["type","nostr_identity_roster_op"]],"pubkey":"1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f","id":"e3838286c5e78095247a144b4744c3c0636bf150633b3ad727f1d73f5219c703","sig":"0518643e193df6634f6d96f5acc9a68696d8cdc56aee65eb64dd9cf113993730dbd42ce05fd7cb115f12fbb00607d79920d274bbc010bd9f1b17e0cd970c8c6b"}',
}

describe('profileAppKeys', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not fall back to AppKeys snapshots when no NostrIdentity id is available', () => {
    const stop = vi.fn()
    const subscribe = vi.fn(() => stop) as unknown as NostrSubscribe
    const observer = observeStore(
      createProfileAppKeysStore(PROFILE_PUBKEY, {
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

  it('subscribes to canonical NostrIdentity roster fact events', () => {
    let onEvent: ((event: SubscribedEvent) => void) | null = null
    const stop = vi.fn()
    const subscribe: NostrSubscribe = (filter, callback) => {
      expect(filter).toEqual({
        kinds: [KIND_NOSTR_IDENTITY_ROSTER_OP],
        '#i': [NOSTR_IDENTITY_ID],
      })
      onEvent = callback
      return stop
    }
    const observer = observeStore(
      createProfileAppKeysStore(PROFILE_PUBKEY, {
        subscribe,
        timeoutMs: 3000,
        nostrIdentityId: NOSTR_IDENTITY_ID,
      })
    )

    expect(observer.current()).toEqual({
      devices: [],
      loading: true,
    })

    const emit = onEvent as unknown as (event: SubscribedEvent) => void
    emit(rawEvent(BOOTSTRAP_OP))

    expect(observer.current()).toEqual({
      devices: [
        {
          identityPubkey: ADMIN_PUBKEY,
          createdAt: 1700000200,
        },
      ],
      loading: false,
    })

    observer.unsubscribe()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('projects local session roster ops while refreshing relays', () => {
    const stop = vi.fn()
    const subscribe = vi.fn(() => stop) as unknown as NostrSubscribe
    const observer = observeStore(
      createProfileAppKeysStore(PROFILE_PUBKEY, {
        subscribe,
        timeoutMs: 3000,
        nostrIdentityId: NOSTR_IDENTITY_ID,
        initialRosterOps: [BOOTSTRAP_OP],
      })
    )

    expect(observer.current()).toEqual({
      devices: [
        {
          identityPubkey: ADMIN_PUBKEY,
          createdAt: 1700000200,
        },
      ],
      loading: true,
    })

    vi.advanceTimersByTime(3000)

    expect(observer.current()).toEqual({
      devices: [
        {
          identityPubkey: ADMIN_PUBKEY,
          createdAt: 1700000200,
        },
      ],
      loading: false,
    })

    observer.unsubscribe()
  })

  it('ignores unrelated fact events for the same subject', () => {
    let onEvent: ((event: SubscribedEvent) => void) | null = null
    const subscribe: NostrSubscribe = (_filter, callback) => {
      onEvent = callback
      return vi.fn()
    }
    const observer = observeStore(
      createProfileAppKeysStore(PROFILE_PUBKEY, {
        subscribe,
        timeoutMs: 3000,
        nostrIdentityId: NOSTR_IDENTITY_ID,
      })
    )

    const emit = onEvent as unknown as (event: SubscribedEvent) => void
    emit({
      kind: KIND_NOSTR_IDENTITY_ROSTER_OP,
      pubkey: ADMIN_PUBKEY,
      content: '',
      created_at: 1700000202,
      tags: [
        ['i', NOSTR_IDENTITY_ID, 'subject'],
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

  it('removes tombstoned device facets from the projected roster', () => {
    let onEvent: ((event: SubscribedEvent) => void) | null = null
    const subscribe: NostrSubscribe = (_filter, callback) => {
      onEvent = callback
      return vi.fn()
    }
    const observer = observeStore(
      createProfileAppKeysStore(PROFILE_PUBKEY, {
        subscribe,
        timeoutMs: 3000,
        nostrIdentityId: NOSTR_IDENTITY_ID,
      })
    )
    const emit = onEvent as unknown as (event: SubscribedEvent) => void
    emit(rawEvent(BOOTSTRAP_OP))
    emit(rawEvent(ADD_DEVICE_OP))

    expect(observer.current().devices.map((device) => device.identityPubkey)).toEqual([
      ADMIN_PUBKEY,
      DEVICE_PUBKEY,
    ])

    emit(rawEvent(REMOVE_DEVICE_OP))

    expect(observer.current().devices.map((device) => device.identityPubkey)).toEqual([
      ADMIN_PUBKEY,
    ])

    observer.unsubscribe()
  })

  it('exports the canonical roster event kind and type for UI/runtime filters', () => {
    expect(KIND_NOSTR_IDENTITY_ROSTER_OP).toBe(7368)
    expect(IDENTITY_GRAPH_ROSTER_TYPE).toBe('nostr_identity_roster_op')
  })
})

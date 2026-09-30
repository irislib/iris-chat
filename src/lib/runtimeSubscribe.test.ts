import { describe, expect, it, vi, afterEach } from 'vitest'
import NostrClient, { EventSubscription, CacheMode } from './nostrClient'

import { createRuntimeSubscribe } from './runtimeSubscribe'

class FakeSubscription {
  private handler: ((event: { rawEvent: () => unknown }) => void) | null = null

  start = vi.fn()
  stop = vi.fn()

  on(_event: 'event', handler: (event: { rawEvent: () => unknown }) => void): void {
    this.handler = handler
  }

  emit(rawEvent: unknown): void {
    this.handler?.({ rawEvent: () => rawEvent })
  }
}

const ALICE = 'A'.repeat(64)
const BOB = 'b'.repeat(64)
const CAROL = 'c'.repeat(64)

const createClient = () => {
  const calls: Array<{
    filter: Record<string, unknown>
    opts: Record<string, unknown>
    subscription: FakeSubscription
  }> = []

  return {
    calls,
    nostrClient: {
      pool: {
        connectedRelays: () => [{ url: 'wss://relay.one' }, { url: 'wss://relay.two' }],
      },
      subscribe: vi.fn((filter: Record<string, unknown>, opts: Record<string, unknown>) => {
        const subscription = new FakeSubscription()
        calls.push({ filter, opts, subscription })
        return subscription
      }),
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})


describe('createRuntimeSubscribe', () => {
  it('starts each real NostrClient subscription once after attaching its handlers', async () => {
    vi.useFakeTimers()
    // Keep NostrClient's real subscribe/autostart scheduling, without opening sockets.
    const start = vi.spyOn(EventSubscription.prototype, 'start').mockReturnValue(null)
    const subscribe = createRuntimeSubscribe(new NostrClient())
    const stop = subscribe({ kinds: [1060], authors: [BOB] }, vi.fn())
    expect(start).toHaveBeenCalledTimes(2) // live + historical backfill
    const subscriptions = [...start.mock.contexts]
    await vi.advanceTimersByTimeAsync(1)
    expect(start.mock.contexts.filter((subscription: EventSubscription) =>
      subscriptions.includes(subscription)
    )).toHaveLength(2)
    stop()
  })

  it('starts a relay-only backfill for newly added DM authors', () => {
    vi.spyOn(Date, 'now').mockReturnValue(20_000)

    const { nostrClient, calls } = createClient()
    const subscribe = createRuntimeSubscribe(nostrClient as never)
    const onEvent = vi.fn()

    const unsubscribe = subscribe(
      {
        kinds: [1060],
        authors: [ALICE],
      },
      onEvent
    )

    expect(calls).toHaveLength(2)
    expect(calls[0]?.filter).toEqual({
      kinds: [1060],
      authors: [ALICE],
    })
    expect(calls[1]?.filter).toEqual({
      kinds: [1060],
      authors: ['a'.repeat(64)],
      limit: 200,
    })
    expect(calls[1]?.opts).toMatchObject({
      closeOnEose: true,
      cacheUsage: CacheMode.ONLY_RELAY,
      relayUrls: ['wss://relay.one', 'wss://relay.two'],
    })

    calls[1]?.subscription.emit({ id: 'backfill-event' })
    expect(onEvent).toHaveBeenCalledWith({ id: 'backfill-event' })

    unsubscribe()
    expect(calls[0]?.subscription.stop).toHaveBeenCalledTimes(1)
    expect(calls[1]?.subscription.stop).toHaveBeenCalledTimes(1)
  })

  it('backfills only authors that were not already tracked', () => {
    const { nostrClient, calls } = createClient()
    const subscribe = createRuntimeSubscribe(nostrClient as never)

    subscribe({ kinds: [1060], authors: [ALICE, BOB] }, vi.fn())
    subscribe({ kinds: [1060], authors: [BOB, CAROL] }, vi.fn())

    expect(calls).toHaveLength(4)
    expect(calls[1]?.filter).toEqual({
      kinds: [1060],
      authors: ['a'.repeat(64), BOB],
      limit: 200,
    })
    expect(calls[3]?.filter).toEqual({
      kinds: [1060],
      authors: [CAROL],
      limit: 200,
    })
  })

  it('starts a relay-only backfill for newly added AppKeys authors', () => {
    const { nostrClient, calls } = createClient()
    const subscribe = createRuntimeSubscribe(nostrClient as never)
    const onEvent = vi.fn()

    const unsubscribe = subscribe(
      {
        kinds: [37368],
        authors: [ALICE],
      },
      onEvent
    )

    expect(calls).toHaveLength(2)
    expect(calls[0]?.filter).toEqual({
      kinds: [37368],
      authors: [ALICE],
    })
    expect(calls[1]?.filter).toEqual({
      kinds: [37368],
      authors: ['a'.repeat(64)],
      limit: 200,
    })
    expect(calls[1]?.opts).toMatchObject({
      closeOnEose: true,
      cacheUsage: CacheMode.ONLY_RELAY,
      relayUrls: ['wss://relay.one', 'wss://relay.two'],
    })

    calls[1]?.subscription.emit({ id: 'appkeys-backfill' })
    expect(onEvent).toHaveBeenCalledWith({ id: 'appkeys-backfill' })

    unsubscribe()
    expect(calls[0]?.subscription.stop).toHaveBeenCalledTimes(1)
    expect(calls[1]?.subscription.stop).toHaveBeenCalledTimes(1)
  })

  it('starts a relay-only backfill for newly added invite response recipients', () => {
    const { nostrClient, calls } = createClient()
    const subscribe = createRuntimeSubscribe(nostrClient as never)
    const onEvent = vi.fn()

    const unsubscribe = subscribe(
      {
        kinds: [1059],
        '#p': [ALICE],
      },
      onEvent
    )

    expect(calls).toHaveLength(2)
    expect(calls[0]?.filter).toEqual({
      kinds: [1059],
      '#p': [ALICE],
    })
    expect(calls[1]?.filter).toEqual({
      kinds: [1059],
      '#p': ['a'.repeat(64)],
      limit: 200,
    })
    expect(calls[1]?.opts).toMatchObject({
      closeOnEose: true,
      cacheUsage: CacheMode.ONLY_RELAY,
      relayUrls: ['wss://relay.one', 'wss://relay.two'],
    })

    calls[1]?.subscription.emit({ id: 'invite-response-backfill' })
    expect(onEvent).toHaveBeenCalledWith({ id: 'invite-response-backfill' })

    unsubscribe()
    expect(calls[0]?.subscription.stop).toHaveBeenCalledTimes(1)
    expect(calls[1]?.subscription.stop).toHaveBeenCalledTimes(1)
  })

  it('tracks author removal when a subscription is cleaned up', () => {
    const { nostrClient, calls } = createClient()
    const subscribe = createRuntimeSubscribe(nostrClient as never)

    const unsubscribe = subscribe({ kinds: [1060], authors: [ALICE] }, vi.fn())
    unsubscribe()
    subscribe({ kinds: [1060], authors: [ALICE] }, vi.fn())

    expect(calls).toHaveLength(4)
    expect(calls[3]?.filter).toEqual({
      kinds: [1060],
      authors: ['a'.repeat(64)],
      limit: 200,
    })
  })

  it('forwards the live FIPS path into the NDR callback once across relay duplicates', () => {
    vi.spyOn(Date, 'now').mockReturnValue(20_000)
    const { nostrClient, calls } = createClient()
    const subscribe = createRuntimeSubscribe(nostrClient as never)
    const onEvent = vi.fn()
    const filter = { kinds: [1060], authors: [ALICE] }
    const unsubscribe = subscribe(filter, onEvent)
    const event = {
      id: 'f'.repeat(64),
      pubkey: ALICE.toLowerCase(),
      kind: 1060,
      created_at: 20,
      tags: [],
      content: 'ciphertext',
      sig: 'e'.repeat(128),
    }
    expect(calls[0]?.opts.sources).toEqual(['fips'])
    expect(calls[1]?.opts.sources).toEqual([])
    calls[1]?.subscription.emit(event)
    calls[0]?.subscription.emit(event)
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith(event)

    unsubscribe()
    expect(onEvent).toHaveBeenCalledTimes(1)
  })
})

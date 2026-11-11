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
      sources: [],
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
      sources: [],
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
      sources: [],
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

  const keys = (count: number, prefix: string) =>
    Array.from({ length: count }, (_, index) => prefix + index.toString(16).padStart(63, '0'))

  it('keeps every message-author chunk separate and never merges them into one filter', () => {
    const { nostrClient, calls } = createClient()
    const subscribe = createRuntimeSubscribe(nostrClient as never)
    const first = keys(700, 'a'), second = keys(650, 'b'), third = keys(3, 'c')
    const events = [vi.fn(), vi.fn(), vi.fn()]
    const stops = [first, second, third].map((authors, index) => subscribe({ kinds: [1060], authors }, events[index]!))

    // One live request and one backfill per chunk, each holding only its own authors.
    expect(calls.map(call => [call.filter.authors, call.filter.limit, call.opts.sources])).toEqual([
      [first, undefined, ['fips']], [first, 200, []],
      [second, undefined, ['fips']], [second, 200, []],
      [third, undefined, ['fips']], [third, 200, []],
    ])
    for (const call of calls) expect((call.filter.authors as string[]).length).toBeLessThanOrEqual(1000)

    // A ratchet step replaces one chunk; the others keep their subscriptions.
    stops[2]!()
    expect(calls.slice(4).every(call => call.subscription.stop.mock.calls.length === 1)).toBe(true)
    expect(calls.slice(0, 4).every(call => call.subscription.stop.mock.calls.length === 0)).toBe(true)
    const replaced = [...third.slice(1), 'c' + 'f'.repeat(63)]
    subscribe({ kinds: [1060], authors: replaced }, events[2]!)
    expect(calls).toHaveLength(8)
    expect(calls[6]?.filter).toEqual({ kinds: [1060], authors: replaced })
    expect(calls[7]?.filter).toEqual({ kinds: [1060], authors: replaced, limit: 200 })

    // Delivery stays with the chunk that asked for the author.
    const event = { id: 'e'.repeat(64), pubkey: second[0], kind: 1060, created_at: 1, tags: [], content: '', sig: 'f'.repeat(128) }
    calls[2]?.subscription.emit(event)
    calls[3]?.subscription.emit(event)
    expect(events.map(handler => handler.mock.calls.length)).toEqual([0, 1, 0])
    stops[0]!(); stops[1]!()
    expect(calls.slice(0, 4).every(call => call.subscription.stop.mock.calls.length === 1)).toBe(true)
  })

  it('follows a full chunk on relays in one request and on device links in parts that fit a frame', () => {
    const { nostrClient, calls } = createClient()
    const subscribe = createRuntimeSubscribe(nostrClient as never)
    const authors = keys(1000, 'd')
    const onEvent = vi.fn()
    const stop = subscribe({ kinds: [1060], authors }, onEvent)

    expect(calls).toHaveLength(4)
    expect(calls[0]?.filter).toEqual({ kinds: [1060], authors })
    expect(calls[0]?.opts).toMatchObject({ closeOnEose: false, sources: [] })
    expect(calls[0]?.opts.relayUrls).toBeUndefined()
    for (const [index, part] of [authors.slice(0, 500), authors.slice(500)].entries()) {
      expect(calls[1 + index]?.filter).toEqual({ kinds: [1060], authors: part })
      expect(calls[1 + index]?.opts).toMatchObject({ closeOnEose: false, relayUrls: [], sources: ['fips'] })
      // A device-to-device frame holds 65,525 bytes.
      expect(JSON.stringify([calls[1 + index]?.filter]).length).toBeLessThan(60_000)
    }
    expect(calls[3]?.filter).toEqual({ kinds: [1060], authors, limit: 200 })
    expect(calls[3]?.opts).toMatchObject({ closeOnEose: true, sources: [] })

    const event = { id: '9'.repeat(64), pubkey: authors[700], kind: 1060, created_at: 1, tags: [], content: '', sig: 'f'.repeat(128) }
    for (const call of calls) call.subscription.emit(event)
    expect(onEvent).toHaveBeenCalledTimes(1)
    stop()
    expect(calls.every(call => call.subscription.stop.mock.calls.length === 1)).toBe(true)

    // 900 authors still fit one frame and stay one subscription.
    const small = createClient()
    createRuntimeSubscribe(small.nostrClient as never)({ kinds: [1060], authors: keys(900, 'e') }, vi.fn())
    expect(small.calls.map(call => call.opts.sources)).toEqual([['fips'], []])
  })
})

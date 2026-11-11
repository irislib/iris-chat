import {
  CacheMode,
  type AppEvent,
  type EventFilter,
  type EventSubscription,
} from './nostrClient'
import {
  buildRuntimeBackfillFilters,
  MESSAGE_EVENT_KIND,
  RuntimeSubscriptionTracker,
  type NostrSubscribe,
} from 'nostr-double-ratchet'
import type { VerifiedEvent } from 'nostr-tools'


const DIRECT_MESSAGE_BACKFILL_LIMIT = 200
// The library opens one subscription per chunk of at most 1,000 message authors.
// A relay takes a whole chunk in one request. A device-to-device frame holds
// 65,525 bytes, about 975 authors, so there a large chunk is followed in parts.
const PEER_AUTHOR_LIMIT = 900
const PEER_AUTHOR_PART = 500
const RECENT_EVENT_LIMIT = 1024
const RECENT_EVENT_TTL_MS = 10 * 60 * 1000

function deduplicatingForwarder(onEvent: (event: VerifiedEvent) => void) {
  const seen = new Map<string, number>()
  return (event: VerifiedEvent) => {
    const now = Date.now()
    const previous = seen.get(event.id)
    if (previous !== undefined && now - previous <= RECENT_EVENT_TTL_MS) return
    seen.delete(event.id)
    seen.set(event.id, now)
    while (seen.size > RECENT_EVENT_LIMIT) {
      const oldest = seen.keys().next().value
      if (oldest === undefined) break
      seen.delete(oldest)
    }
    onEvent(event)
  }
}

interface RuntimeSubscribeClient {
  subscribe: (
    filter: EventFilter,
    opts: {
      closeOnEose: boolean
      cacheUsage: CacheMode
      relayUrls?: string[]
      sources?: readonly string[]
    },
    autoStart?: boolean
  ) => EventSubscription
}

export const createRuntimeSubscribe = (
  client: RuntimeSubscribeClient,
  cacheUsage: CacheMode = CacheMode.PARALLEL
): NostrSubscribe => {
  const tracker = new RuntimeSubscriptionTracker()

  return (filter, onEvent) => {
    const forward = deduplicatingForwarder(onEvent)
    const forwardEvent = (event: AppEvent) =>
      forward(event.rawEvent() as Parameters<typeof onEvent>[0])

    // Every chunk is tracked, deduplicated and backfilled on its own: chunks
    // are never merged back into one filter a relay would refuse whole.
    const registered = tracker.registerFilter(filter)

    const authors = Array.isArray(filter.kinds) && filter.kinds.includes(MESSAGE_EVENT_KIND) &&
      Array.isArray(filter.authors) ? filter.authors : []
    const peerParts: string[][] = []
    if (authors.length > PEER_AUTHOR_LIMIT) {
      for (let start = 0; start < authors.length; start += PEER_AUTHOR_PART) {
        peerParts.push(authors.slice(start, start + PEER_AUTHOR_PART))
      }
    }
    const liveSubscriptions = [
      client.subscribe(
        filter as EventFilter,
        // Let the runtime follow all configured relays, including reconnects.
        // A snapshot of currently connected relays can strand live interests.
        { closeOnEose: false, cacheUsage, sources: peerParts.length ? [] : ['fips'] },
        false
      ),
      ...peerParts.map(part => client.subscribe(
        { ...filter, authors: part } as EventFilter,
        { closeOnEose: false, cacheUsage: CacheMode.ONLY_RELAY, relayUrls: [], sources: ['fips'] },
        false
      )),
    ]
    for (const liveSubscription of liveSubscriptions) {
      liveSubscription.on('event', forwardEvent)
      liveSubscription.start()
    }

    const backfillSubscriptions = buildRuntimeBackfillFilters(
      registered,
      DIRECT_MESSAGE_BACKFILL_LIMIT
    ).map((backfillFilter) =>
      client.subscribe(
          backfillFilter as EventFilter,
          {
            closeOnEose: true,
            cacheUsage: CacheMode.ONLY_RELAY,
            sources: [],
          },
          false
        )
    )

    for (const backfillSubscription of backfillSubscriptions) {
      backfillSubscription.on('event', forwardEvent)
      backfillSubscription.start()
    }

    return () => {
      tracker.unregister(registered.token)
      for (const backfillSubscription of backfillSubscriptions) {
        backfillSubscription.stop()
      }
      for (const liveSubscription of liveSubscriptions) liveSubscription.stop()
    }
  }
}

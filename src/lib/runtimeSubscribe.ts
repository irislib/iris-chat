import {
  CacheMode,
  type AppEvent,
  type EventFilter,
  type EventSubscription,
} from './nostrClient'
import {
  buildRuntimeBackfillFilters,
  RuntimeSubscriptionTracker,
  type NostrSubscribe,
} from 'nostr-double-ratchet'
import type { VerifiedEvent } from 'nostr-tools'


const DIRECT_MESSAGE_BACKFILL_LIMIT = 200
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

    const registered = tracker.registerFilter(filter)

    const liveSubscription = client.subscribe(
        filter as EventFilter,
        // Let the runtime follow all configured relays, including reconnects.
        // A snapshot of currently connected relays can strand live interests.
        { closeOnEose: false, cacheUsage, sources: ['fips'] },
        false
      )
    liveSubscription.on('event', forwardEvent)
    liveSubscription.start()

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
      liveSubscription.stop()
    }
  }
}

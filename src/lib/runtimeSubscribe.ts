import {
  NDKSubscriptionCacheUsage,
  type NDKEvent,
  type NDKFilter,
  type NDKSubscription,
} from '@nostr-dev-kit/ndk'
import {
  buildRuntimeBackfillFilters,
  RuntimeSubscriptionTracker,
  type NostrSubscribe,
} from 'nostr-double-ratchet'
import type { VerifiedEvent } from 'nostr-tools'

import { asNdkEventSubscription } from './ndkSubscription'
import { subscribeNostrPubsub } from './nostrPubsubRuntime'

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

interface RuntimeSubscribeNdk {
  pool: {
    connectedRelays: () => Array<{ url: string }>
  }
  subscribe: (
    filter: NDKFilter,
    opts: {
      closeOnEose: boolean
      cacheUsage: NDKSubscriptionCacheUsage
      relayUrls?: string[]
    }
  ) => NDKSubscription
}

export const createRuntimeSubscribe = (
  ndkInstance: RuntimeSubscribeNdk,
  cacheUsage: NDKSubscriptionCacheUsage = NDKSubscriptionCacheUsage.PARALLEL
): NostrSubscribe => {
  const tracker = new RuntimeSubscriptionTracker()

  return (filter, onEvent) => {
    const relayUrls = ndkInstance.pool.connectedRelays().map((relay) => relay.url)
    const relayOptions = relayUrls.length > 0 ? { relayUrls } : {}
    const forward = deduplicatingForwarder(onEvent)
    const forwardEvent = (event: NDKEvent) =>
      forward(event.rawEvent() as Parameters<typeof onEvent>[0])
    const stopPubsub = subscribeNostrPubsub(filter, forward)

    const registered = tracker.registerFilter(filter)

    const liveSubscription = asNdkEventSubscription(
      ndkInstance.subscribe(filter as NDKFilter, {
        closeOnEose: false,
        cacheUsage,
        ...relayOptions,
      })
    )
    liveSubscription.on('event', forwardEvent)
    liveSubscription.start()

    const backfillSubscriptions = buildRuntimeBackfillFilters(
      registered,
      DIRECT_MESSAGE_BACKFILL_LIMIT
    ).map((backfillFilter) =>
      asNdkEventSubscription(
        ndkInstance.subscribe(backfillFilter as NDKFilter, {
          closeOnEose: true,
          cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
          ...relayOptions,
        })
      )
    )

    for (const backfillSubscription of backfillSubscriptions) {
      backfillSubscription.on('event', forwardEvent)
      backfillSubscription.start()
    }

    return () => {
      tracker.unregister(registered.token)
      stopPubsub()
      for (const backfillSubscription of backfillSubscriptions) {
        backfillSubscription.stop()
      }
      liveSubscription.stop()
    }
  }
}

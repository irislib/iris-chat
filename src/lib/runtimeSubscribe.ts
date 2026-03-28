import {
  NDKSubscriptionCacheUsage,
  type NDKEvent,
  type NDKFilter,
  type NDKSubscription,
} from '@nostr-dev-kit/ndk'
import {
  buildDirectMessageBackfillFilter,
  DirectMessageSubscriptionTracker,
  type NostrSubscribe,
} from 'nostr-double-ratchet'

import { asNdkEventSubscription } from './ndkSubscription'

const DIRECT_MESSAGE_BACKFILL_LOOKBACK_SECONDS = 15
const DIRECT_MESSAGE_BACKFILL_LIMIT = 200

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
  const tracker = new DirectMessageSubscriptionTracker()

  return (filter, onEvent) => {
    const relayUrls = ndkInstance.pool.connectedRelays().map((relay) => relay.url)
    const relayOptions = relayUrls.length > 0 ? { relayUrls } : {}
    const forwardEvent = (event: NDKEvent) => {
      onEvent(event.rawEvent() as Parameters<typeof onEvent>[0])
    }

    const { token, addedAuthors } = tracker.registerFilter(filter)

    const liveSubscription = asNdkEventSubscription(
      ndkInstance.subscribe(filter as NDKFilter, {
        closeOnEose: false,
        cacheUsage,
        ...relayOptions,
      })
    )
    liveSubscription.on('event', forwardEvent)
    liveSubscription.start()

    const backfillSubscription = addedAuthors.length
      ? asNdkEventSubscription(
          ndkInstance.subscribe(
            buildDirectMessageBackfillFilter(
              addedAuthors,
              Math.floor(Date.now() / 1000) - DIRECT_MESSAGE_BACKFILL_LOOKBACK_SECONDS,
              DIRECT_MESSAGE_BACKFILL_LIMIT
            ) as NDKFilter,
            {
              closeOnEose: true,
              cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
              ...relayOptions,
            }
          )
        )
      : null

    backfillSubscription?.on('event', forwardEvent)
    backfillSubscription?.start()

    return () => {
      tracker.unregister(token)
      backfillSubscription?.stop()
      liveSubscription.stop()
    }
  }
}

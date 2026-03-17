import type { NDKEvent, NDKSubscription } from '@nostr-dev-kit/ndk'

export type NdkEventSubscription = NDKSubscription & {
  on: (event: 'event', handler: (event: NDKEvent) => void) => void
}

export function asNdkEventSubscription(
  subscription: NDKSubscription
): NdkEventSubscription {
  return subscription as NdkEventSubscription
}

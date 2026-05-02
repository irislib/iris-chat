import { NDKEvent } from '@nostr-dev-kit/ndk'
import type { NostrSubscribe } from 'nostr-double-ratchet'
import { get } from 'svelte/store'
import { devices } from './devices'
import { getPrivkeyBytes, identity, ndk } from './identity'
import { asNdkEventSubscription } from './ndkSubscription'
import { createProfileAppKeysStore } from './profileAppKeys'

const createNostrSubscribe = (): NostrSubscribe => {
  const ndkInstance = get(ndk)

  return (filter, onEvent) => {
    const subscription = asNdkEventSubscription(
      ndkInstance.subscribe(filter, { closeOnEose: false })
    )

    subscription.on('event', (event: NDKEvent) => {
      onEvent(event.rawEvent() as Parameters<typeof onEvent>[0])
    })

    subscription.start()

    return () => subscription.stop()
  }
}

export const createRuntimeProfileAppKeysStore = (pubkey: string | undefined) => {
  const myPubkey = get(identity)?.pubkey
  const isOwnProfile = !!pubkey && myPubkey === pubkey
  const initialDevices = isOwnProfile ? get(devices).registeredDevices : []

  return createProfileAppKeysStore(pubkey, {
    subscribe: createNostrSubscribe(),
    initialDevices,
    ownerPrivateKey: isOwnProfile ? getPrivkeyBytes() : undefined,
  })
}

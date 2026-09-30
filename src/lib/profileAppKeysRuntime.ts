import { AppEvent } from './nostrClient'
import type { PeopleSubscribe } from './messagingPeople'
import { get } from 'svelte/store'
import { nostrClient } from './identity'
import { getNdrRuntime } from './privateChats'
import { createProfileAppKeysStore } from './profileAppKeys'

export const createNostrSubscribe = (): PeopleSubscribe => {
  const client = get(nostrClient)

  return (filter, onEvent, onEose) => {
    const subscription = client.subscribe(filter, { closeOnEose: false }, false)

    subscription.on('event', (event: AppEvent) => {
      onEvent(event.rawEvent() as Parameters<typeof onEvent>[0])
    })
    if (onEose) subscription.on('eose', onEose)

    subscription.start()

    return () => subscription.stop()
  }
}

export const createRuntimeProfileAppKeysStore = (pubkey: string | undefined) => {
  const known = pubkey ? getNdrRuntime().getKnownAppKeysSnapshots().find(snapshot => snapshot.ownerPubkey === pubkey) : undefined
  return createProfileAppKeysStore(pubkey, {
    subscribe: createNostrSubscribe(),
    initialDevices: known?.appKeys.getAllDevices(),
    initialCreatedAt: known?.createdAt,
  })
}

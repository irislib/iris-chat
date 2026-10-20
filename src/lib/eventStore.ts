import { canRetryWorkerPublication } from './workerPublicationPolicy'
import { isPrivateRelayEvent, type RuntimeEventStore } from 'nostr-pubsub/private-relays'
import type { RuntimeOutboxEntry } from 'nostr-pubsub'
import Dexie, { type Table } from 'dexie'
import { DexieStore } from '@hashtree/dexie'
import { HashtreeRuntimeEventStore, type HashtreeRuntimeState } from '@hashtree/nostr-pubsub'

/** Persist indexes locally; attachment peers never receive these private index blocks. */
const pendingReaders = new WeakMap<object, () => Promise<RuntimeOutboxEntry[]>>()
export function createEventStore(owner = 'public', lane?: 'public' | 'private') {
  const blocks = new DexieStore(`iris-chat-event-blocks-${owner}`)
  const pointers = new Dexie(`iris-chat-event-roots-${owner}`) as Dexie & { roots: Table<HashtreeRuntimeState, string> }
  pointers.version(1).stores({ roots: '' })
  const store = new HashtreeRuntimeEventStore(blocks, {
    load: async () => await pointers.roots.get('runtime') ?? null,
    save: async state => { await pointers.roots.put(state, 'runtime') },
    withLock: async operation => typeof navigator !== 'undefined' && navigator.locks
      ? navigator.locks.request(`iris-chat-event-root-${owner}`, operation) : operation(),
    close: () => pointers.close(),
  })
  const pending = store.listPending.bind(store)
  pendingReaders.set(store, pending)
  // Keep old signed data locally, but never expose it to automatic publication.
  // Filtering on every read also covers a still-open older tab adding a row.
  store.listPending = async () => (await pending()).filter(entry => canRetryWorkerPublication(entry.event) &&
    (!lane || isPrivateRelayEvent(entry.event) === (lane === 'private')))
  return store
}

/** Copy before retiring an old mixed-lane retry; failed migrations remain recoverable. */
export async function migratePrivatePending(receiver: RuntimeEventStore,
  sender: RuntimeEventStore, active = () => true): Promise<void> {
  const retained = await pendingReaders.get(receiver)!()
  for (const entry of retained) {
    if (!active()) return
    if (!canRetryWorkerPublication(entry.event) || !isPrivateRelayEvent(entry.event)) continue
    await sender.putPending(structuredClone(entry))
    if (!active()) return
    await receiver.deletePending(entry.event.id)
  }
}

import { canRetryWorkerPublication } from './workerPublicationPolicy'
import Dexie, { type Table } from 'dexie'
import { DexieStore } from '@hashtree/dexie'
import { HashtreeRuntimeEventStore, type HashtreeRuntimeState } from '@hashtree/nostr-pubsub'

/** Persist indexes locally; attachment peers never receive these private index blocks. */
export function createEventStore(owner = 'public') {
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
  // Keep old signed data locally, but never expose it to automatic publication.
  // Filtering on every read also covers a still-open older tab adding a row.
  store.listPending = async () => (await pending()).filter(entry => canRetryWorkerPublication(entry.event))
  return store
}

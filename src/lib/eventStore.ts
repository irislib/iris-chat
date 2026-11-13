import { canRetryWorkerPublication, type PublicationCarrier } from './workerPublicationPolicy'
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
  // A queued message envelope looks exactly like shared group ciphertext, so the
  // queue keeps who vouched for it beside its retry row. Rows without that
  // record, including every row from an older version, stay local.
  const vouchers = pointers.roots as unknown as Table<{ carrier: PublicationCarrier; at: number }, string>
  const voucherKey = (id: string) => `carrier/${id}`
  // Only recorded publication handoffs can be retried after a worker restart.
  // Missing or unrecognized vouchers leave old ciphertext in local storage.
  store.listPending = async () => {
    const entries = await pending()
    const rows = await vouchers.bulkGet(entries.map(entry => voucherKey(entry.event.id)))
    return entries.filter((entry, index) => canRetryWorkerPublication(entry.event, rows[index]?.carrier) &&
      (!lane || isPrivateRelayEvent(entry.event) === (lane === 'private')))
  }
  const deletePending = store.deletePending.bind(store)
  store.deletePending = async id => { await deletePending(id); await vouchers.delete(voucherKey(id)) }
  return Object.assign(store, {
    /** Called only for an envelope the publication context vouched for. */
    vouchPending: async (id: string, carrier: PublicationCarrier) => { await vouchers.put({ carrier, at: Date.now() }, voucherKey(id)) },
  })
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

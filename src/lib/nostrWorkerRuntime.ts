import {
  createNostrRuntime, createPrivateRelayPublisher, MemoryEventStore,
  isPrivateRelayEvent, type NostrEvent, type NostrRuntimeOptions, type RuntimeEventStore,
} from 'nostr-pubsub/private-relays'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { createEventStore, migratePrivatePending } from './eventStore'
import { assertWorkerPublicationPolicy, type WorkerPublishOptions } from './workerPublicationPolicy'
import { privateDiscoverySubscribe } from './privateDiscoveryRouting'
import { isPublicRelayKind, publicRelaySubscriptions } from './publicRelayRouting'

export const MESSAGE_AUTHOR_REQUEST_BYTES = 72_000

/** The worker and restart recovery share the same durable admission boundary. */
export function createNostrWorkerRuntime(owner: string, signAuthEvent?: NostrRuntimeOptions['signAuthEvent']) {
  const receiverStore = createEventStore(owner, 'public')
  const privateStore = createEventStore(`${owner}:private-send`, 'private')
  const closeReceiverStore = receiverStore.close.bind(receiverStore)
  const closePrivateStore = privateStore.close.bind(privateStore)
  // The facade owns these databases: all writers and migration must finish first.
  receiverStore.close = async () => {}
  privateStore.close = async () => {}
  const runtime = createNostrRuntime({
    store: receiverStore, batchWindowMs: 20, historyTimeoutMs: 5000, signAuthEvent,
    // Messages are found only by sender ratchet key, in chunks of up to 1,000
    // authors (about 67,100 bytes). The default bound of 32,768 bytes refuses such
    // a chunk whole, which stops delivery; relay frames hold 131,072 bytes.
    maxFilterBytesPerBatch: MESSAGE_AUTHOR_REQUEST_BYTES,
  })
  // Share only the local ciphertext cache, so FIPS can still serve retained
  // outgoing messages. The receiver never owns or retries the sender's queue.
  const senderStore: RuntimeEventStore = {
    query: (filters, options) => receiverStore.query(filters, options),
    put: event => receiverStore.put(event),
    delete: ids => receiverStore.delete(ids),
    listPending: () => privateStore.listPending(),
    putPending: entry => privateStore.putPending(entry),
    deletePending: id => privateStore.deletePending(id),
  }
  const privateSender = createPrivateRelayPublisher({ store: senderStore })
  let groupReader: ReturnType<typeof createNostrRuntime> | undefined
  let messageRelays: readonly string[] = []

  function groupRead(filters: Parameters<typeof runtime.subscribe>[0]) {
    const allowedKeys = ['kinds', 'authors', 'since', 'until', 'limit']
    if (!filters.length || filters.some(filter =>
      filter.kinds?.length !== 1 || filter.kinds[0] !== 1060 || !filter.authors?.length ||
      filter.authors.some(author => !/^[0-9a-f]{64}$/.test(author)) ||
      Object.keys(filter).some(key => !allowedKeys.includes(key)))) {
      throw new Error('Group history requires an encrypted-message author filter')
    }
    if (!groupReader) {
      // Share local ciphertext history, with independent sockets and an empty outbox.
      const store = new MemoryEventStore()
      store.put = event => receiverStore.put(event)
      store.query = (requested, options) => receiverStore.query(requested, options)
      groupReader = createNostrRuntime({
        store,
        maxFilterBytesPerBatch: MESSAGE_AUTHOR_REQUEST_BYTES,
        signAuthEvent: async (_relay, template) => finalizeEvent(template, generateSecretKey()),
      })
      groupReader.setRelays(messageRelays)
    }
    return groupReader
  }
  const subscribeToGroup: typeof runtime.subscribe = (filters, handlers, options) =>
    groupRead(filters).subscribe(filters, handlers, { ...options, sources: [] })
  const queryGroup: typeof runtime.query = (filters, options) =>
    groupRead(filters).query(filters, { ...options, sources: [] })

  let publicRelays: readonly string[] = []
  const sourceIds = new Set<string>()
  const publicReads = publicRelaySubscriptions(
    privateDiscoverySubscribe(runtime.subscribe.bind(runtime)),
    () => publicRelays, () => [...sourceIds])
  runtime.subscribe = publicReads.subscribe
  let closed = false
  const migration = migratePrivatePending(runtime.store, privateStore, () => !closed)
  void migration.then(() => { if (!closed) void privateSender.retryPending() }).catch(error => {
    if (!closed) console.warn('Private message retries could not be restored', error)
  })
  const publish = runtime.publish.bind(runtime)
  // `carrier` is the caller's statement of what produced a message envelope. It
  // never reaches the transport, and nothing is sent without it.
  const publishWithPolicy = async (event: NostrEvent, { carrier, ...options }: WorkerPublishOptions = {}) => {
    assertWorkerPublicationPolicy(event, carrier)
    await migration
    if (isPrivateRelayEvent(event)) {
      // A queued envelope outlives this call and this worker, so its voucher must too.
      if (carrier && !options.requireAck && options.queue !== false) await privateStore.vouchPending(event.id, carrier)
      return privateSender.publish(event, carrier === 'group-sender-key' ? { ...options, sources: [] } : options)
    }
    const publicOptions = options.relays === undefined && isPublicRelayKind(event.kind)
      ? { ...options, relays: publicRelays, sources: options.sources ?? [...sourceIds] } : options
    return publish(event, publicOptions)
  }
  runtime.publish = publishWithPolicy
  const setRelays = runtime.setRelays.bind(runtime)
  const setRelayRoutes = (relays: readonly string[], privateRelays: readonly string[] = relays) => {
    const changed = JSON.stringify(publicRelays) !== JSON.stringify(relays)
    publicRelays = [...relays]
    // The runtime's implicit route is the existing private policy. Only known
    // public operations receive the additional public destinations above.
    setRelays(privateRelays)
    privateSender.setRelays(privateRelays)
    messageRelays = [...privateRelays]
    groupReader?.setRelays(messageRelays)
    if (changed) publicReads.update()
  }
  runtime.setRelays = relays => setRelayRoutes(relays)
  const addSource = runtime.addSource.bind(runtime), removeSource = runtime.removeSource.bind(runtime)
  runtime.addSource = source => {
    addSource(source)
    sourceIds.add(source.id); publicReads.update()
    if (source.publish) privateSender.addSource({ ...source, publish: source.publish })
  }
  runtime.removeSource = id => { removeSource(id); privateSender.removeSource(id)
    if (sourceIds.delete(id)) publicReads.update() }
  const getRelayStats = runtime.getRelayStats.bind(runtime)
  runtime.getRelayStats = () => {
    const stats = new Map(getRelayStats().map(stat => [stat.url, stat]))
    for (const stat of privateSender.getRelayStats()) {
      stats.set(stat.url, { ...stat, connected: stat.connected || !!stats.get(stat.url)?.connected })
    }
    return [...stats.values()]
  }
  const close = runtime.close.bind(runtime)
  runtime.close = async () => {
    closed = true
    publicReads.close()
    // Stop networking before awaiting a potentially slow durable migration.
    const closing = Promise.all([close(), privateSender.close(), groupReader?.close()])
    await migration.catch(() => {})
    await closing
    await Promise.all([closeReceiverStore(), closePrivateStore()])
  }
  return Object.assign(runtime, { setRelayRoutes, subscribeToGroup, queryGroup, publish: publishWithPolicy })
}

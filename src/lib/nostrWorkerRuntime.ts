import {
  createNostrRuntime, createPrivateRelayPublisher, createAnonymousRelayDiscovery,
  isPrivateRelayEvent, type NostrRuntimeOptions, type RuntimeEventStore,
} from 'nostr-pubsub/private-relays'
import { createEventStore, migratePrivatePending } from './eventStore'
import { assertWorkerPublicationPolicy } from './workerPublicationPolicy'
import { privateDiscoverySubscribe } from './privateDiscoveryRouting'
import { isPublicRelayKind, publicRelaySubscriptions } from './publicRelayRouting'

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
  const discovery = createAnonymousRelayDiscovery({ store: runtime.store, historyTimeoutMs: 5000 })
  let publicRelays: readonly string[] = []
  const sourceIds = new Set<string>()
  const publicReads = publicRelaySubscriptions(
    privateDiscoverySubscribe(runtime.subscribe.bind(runtime), discovery.subscribe.bind(discovery)),
    () => publicRelays, () => [...sourceIds])
  runtime.subscribe = publicReads.subscribe
  let closed = false
  const migration = migratePrivatePending(runtime.store, privateStore, () => !closed)
  void migration.then(() => { if (!closed) void privateSender.retryPending() }).catch(error => {
    if (!closed) console.warn('Private message retries could not be restored', error)
  })
  const publish = runtime.publish.bind(runtime)
  runtime.publish = async (event, options = {}) => {
    assertWorkerPublicationPolicy(event)
    await migration
    if (isPrivateRelayEvent(event)) return privateSender.publish(event, options)
    const publicOptions = options.relays === undefined && isPublicRelayKind(event.kind)
      ? { ...options, relays: publicRelays, sources: options.sources ?? [...sourceIds] } : options
    return publish(event, publicOptions)
  }
  const setRelays = runtime.setRelays.bind(runtime)
  const setRelayRoutes = (relays: readonly string[], privateRelays: readonly string[] = relays) => {
    const changed = JSON.stringify(publicRelays) !== JSON.stringify(relays)
    publicRelays = [...relays]
    // The runtime's implicit route is the existing private policy. Only known
    // public operations receive the additional public destinations above.
    setRelays(privateRelays)
    privateSender.setRelays(privateRelays)
    discovery.setRelays(privateRelays)
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
    for (const stat of [...privateSender.getRelayStats(), ...discovery.getRelayStats()]) {
      stats.set(stat.url, { ...stat, connected: stat.connected || !!stats.get(stat.url)?.connected })
    }
    return [...stats.values()]
  }
  const close = runtime.close.bind(runtime)
  runtime.close = async () => {
    closed = true
    publicReads.close()
    // Stop networking before awaiting a potentially slow durable migration.
    const closing = Promise.all([discovery.close(), close(), privateSender.close()])
    await migration.catch(() => {})
    await closing
    await Promise.all([closeReceiverStore(), closePrivateStore()])
  }
  return Object.assign(runtime, { setRelayRoutes })
}

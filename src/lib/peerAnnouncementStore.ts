import { IndexedDbEventBus, RetainedPeerDiscovery,
  type NostrEventReader, type NostrRuntime } from 'nostr-pubsub'

/** Targeted discovery stays local. Only our own signed advert is replayable. */
export async function openPeerAnnouncementStore(owner: string, device: string, scope: string,
  runtime: Pick<NostrRuntime, 'publish' | 'subscribe'>) {
  const store = await IndexedDbEventBus.open('iris-chat:peer-discovery:' + owner + ':' + device + ':' + scope,
    { maxEvents: 256, filters: [{ kinds: [37195], '#d': [scope] }] })
  const discovery = new RetainedPeerDiscovery(runtime, store,
    error => console.warn('Peer announcement storage failed', error))
  const publicReader: NostrEventReader = { query: async (filters, options) => {
    const ownFilters = filters.filter(filter => !filter.authors || filter.authors.some(prefix => device.startsWith(prefix)))
      .map(filter => ({ ...filter, authors: [device] }))
    if (!ownFilters.length) return { complete: true, events: [] }
    return store.query(ownFilters, options)
  } }
  return { discovery, publicReader, close: async () => {
    try { await discovery.close() } finally { store.close() }
  } }
}

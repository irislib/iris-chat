import { FipsNostrPubsubClient, FipsNostrPubsubEventSource, SOURCE_PRIORITY_LOCAL_INDEX,
  localIndexSource, verifyNostrEvent, type FipsPubsubClientNode, type NostrRuntime } from 'nostr-pubsub'

import { canRetryWorkerPublication } from './workerPublicationPolicy'
import { normalizeDeviceSyncPeer } from './deviceSyncTcp'

const ALLOWED_RUNTIME_KINDS = [1059, 1060, 30078, 37368]
type Runtime = Pick<NostrRuntime, 'addSource' | 'removeSource' | 'query'>

/** The existing device-sync node carries the worker's interests and retained ciphertext events. */
export class NostrPubsubRuntime {
  private client?: FipsNostrPubsubClient
  private runtime?: Runtime
  async activate(node: FipsPubsubClientNode, localPeerId: string,
    peers: () => readonly string[], runtime: Runtime): Promise<void> {
    await this.deactivate()
    this.runtime = runtime
    // Device authorization uses x-only keys. FIPS can authenticate either
    // compressed-key parity, as on the account-history stream.
    const canonicalNode: FipsPubsubClientNode = {
      registerService: (port, handler) => node.registerService(port, context =>
        handler({ ...context, src: normalizeDeviceSyncPeer(context.src) })),
      sendDatagram: args => node.sendDatagram({ ...args, dst: normalizeDeviceSyncPeer(args.dst) }),
      ...(node.on ? { on: (event, listener) => node.on!(event, value => {
        if (value && typeof value === 'object' && 'remotePubkey' in value && typeof value.remotePubkey === 'string')
          listener({ ...value, remotePubkey: normalizeDeviceSyncPeer(value.remotePubkey) })
        else listener(value)
      }) } : {}),
    }
    this.client = new FipsNostrPubsubClient({ node: canonicalNode,
      localPeerId: normalizeDeviceSyncPeer(localPeerId), peers: () => peers().map(normalizeDeviceSyncPeer),
      allowedKinds: ALLOWED_RUNTIME_KINDS,
      limits: { maxCachedEvents: 256, maxReplayEvents: 256, maxFiltersPerSubscription: 32 },
      retainedEventReader: { query: async (filters, options) => {
        const result = await runtime.query(filters, { cache: 'cache-only', limit: options?.limit })
        return { complete: result.complete, events: result.events.filter(canRetryWorkerPublication).map(event => ({
          event: verifyNostrEvent(event), source: localIndexSource('chat-cache'), priority: SOURCE_PRIORITY_LOCAL_INDEX,
        })) }
      } },
      onError: (error, context) => console.warn(`[nostrPubsub] ${context.operation} failed:`, error),
    }).start()
    runtime.addSource(new FipsNostrPubsubEventSource(this.client))
  }
  async deactivate() {
    this.runtime?.removeSource('fips'); this.runtime = undefined
    const client = this.client; this.client = undefined
    await client?.stop()
  }
  async idle() { await this.client?.idle() }
}
const runtime = new NostrPubsubRuntime()
export const activateNostrPubsub = (...args: Parameters<NostrPubsubRuntime['activate']>) => runtime.activate(...args)
export const deactivateNostrPubsub = () => runtime.deactivate()

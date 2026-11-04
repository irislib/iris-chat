import { FipsNode, generateIdentity, type PeerEvent } from '@fips/core'
import { WebSocketTransport } from '@fips/transport-websocket'
import type { FipsDatagramEndpoint } from '@fips/tcp'
import type { Hash, Store } from '@hashtree/core'
import { toHex } from '@hashtree/core'
import { TcpBlobTransport } from '@hashtree/fips-transport'
import { createFipsWorkerP2PProvider } from '@hashtree/fips-transport/worker'
import { attachmentEndpoint } from './attachmentEndpoint'
import { normalizeDeviceSyncPeer } from './deviceSyncTcp'

export interface AttachmentProviders {
  servers: readonly string[]
  peers: () => readonly string[]
}

/** Provider reads must never acquire this account's identity or private cache. */
const noCache: Store = {
  get: async () => null,
  put: async () => false,
  has: async () => false,
  delete: async () => false,
}

export function createAttachmentTransport(options: {
  endpoint: FipsDatagramEndpoint
  store: Store
  siblings: () => readonly string[]
  allowSibling: (peer: string) => boolean
  providers?: AttachmentProviders
}) {
  let closed = false
  let closing: Promise<void> | undefined
  const allowed = (peer: string) => !closed && options.allowSibling(normalizeDeviceSyncPeer(peer))
  // Check every datagram too: revocation also cuts off already accepted streams.
  const siblingEndpoint = attachmentEndpoint(options.endpoint, allowed)
  const siblings = new TcpBlobTransport({ endpoint: siblingEndpoint.endpoint,
    localStore: options.store, allowIncomingPeer: allowed })

  type AnonymousReader = { provider: ReturnType<typeof createFipsWorkerP2PProvider>; stop: () => Promise<void> } | undefined
  let reader: AnonymousReader
  let starting: Promise<AnonymousReader> | undefined

  async function openAnonymousReader(): Promise<AnonymousReader> {
    if (closed || !options.providers?.servers.length) return
    const identity = await generateIdentity()
    if (closed) { identity.secretKey.fill(0); return }
    // No WebRTC/Nostr discovery, account announcements or shared device links.
    const node = new FipsNode({ identity, forwarding: false, routingMode: 'reply_learned',
      transports: [new WebSocketTransport({ seedUrls: options.providers.servers })] })
    const endpoint = attachmentEndpoint(node)
    const adjacent = new Set<string>()
    node.on('peer', value => {
      const event = value as PeerEvent, peer = normalizeDeviceSyncPeer(event.remotePubkey)
      if (event.state === 'connected') adjacent.add(peer)
      else if (event.state === 'disconnected') adjacent.delete(peer)
    })
    const provider = createFipsWorkerP2PProvider({ node: endpoint.endpoint, localStore: noCache,
      allowIncomingPeer: () => false,
      // Existing configured peers remain local-only sources. Seeds must first
      // prove that they implement the blob service, using an anonymous probe.
      providerRoutes: () => closed ? [] : [...new Set(options.providers!.peers().map(normalizeDeviceSyncPeer))]
        .filter(peer => !allowed(peer)).map(peerId => ({ peerId, htl: 0 })),
      candidatePeerIds: () => closed ? [] : [...adjacent].filter(peer => !allowed(peer)),
    })
    let stopping: Promise<void> | undefined
    const stop = () => stopping ??= (async () => {
      endpoint.close(); adjacent.clear()
      const tcpClosing = provider.transport.close()
      provider.close()
      await Promise.allSettled([tcpClosing, node.stop()])
      identity.secretKey.fill(0)
    })()
    const current = { provider, stop }
    reader = current
    try {
      await node.start()
      if (closed) { await stop(); return }
      return current
    } catch (error) {
      await stop()
      if (reader === current) reader = undefined
      throw error
    }
  }

  return {
    async get(hash: Hash): Promise<Uint8Array | null> {
      if (closed) return null
      const peers = [...new Set(options.siblings().map(normalizeDeviceSyncPeer))].filter(allowed)
      const local = peers.length ? await siblings.get(hash, peers, 0).catch(() => null) : null
      if (closed) return null
      if (local) return local
      if (!starting) {
        starting = openAnonymousReader()
        void starting.catch(() => { starting = undefined })
      }
      const anonymous = await starting
      if (closed || !anonymous) return null
      const data = await anonymous.provider.fetch(toHex(hash))
      return closed ? null : data
    },
    close(): Promise<void> {
      if (closing) return closing
      closed = true; siblingEndpoint.close()
      const stopping = reader?.stop()
      return closing = (async () => {
        await Promise.allSettled([siblings.close(), stopping, starting])
        await reader?.stop()
      })()
    },
  }
}

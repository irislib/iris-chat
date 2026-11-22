import type { PeerEvent } from '@fips/core'

/** Device TCP and call APIs use the even compressed spelling as a dial address. */
export function normalizeDeviceSyncPeer(peer: string): string {
  const normalized = peer.toLowerCase()
  return /^(02|03)[0-9a-f]{64}$/.test(normalized) ? `02${normalized.slice(2)}` : peer
}

export function servicePeer(context: { peerId?: string; src: string }): string {
  return context.peerId === undefined ? normalizeDeviceSyncPeer(context.src) : `02${context.peerId}`
}

export class ConnectedDevicePeers {
  private readonly paths = new Map<string, string>()

  update(event: PeerEvent & { peerId?: string }) {
    const path = `${event.remoteAddr.transport}:${event.remoteAddr.addr}`
    const peer = event.peerId === undefined ? normalizeDeviceSyncPeer(event.remotePubkey) : `02${event.peerId}`
    if (event.state === 'connected') this.paths.set(path, peer)
    else if (this.paths.get(path) === peer) this.paths.delete(path)
  }

  peers() { return [...new Set(this.paths.values())] }
}

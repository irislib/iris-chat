import type { FipsDatagramEndpoint } from '@fips/tcp'
import { normalizeDeviceSyncPeer } from './deviceSyncTcp'

/** Reliable blob TCP must not stall all providers behind one absent peer's route lookup. */
export function attachmentEndpoint(node: FipsDatagramEndpoint) {
  let closed = false, bytes = 0, packets = 0
  const perPeer = new Map<string, number>()
  const endpoint: FipsDatagramEndpoint = {
    registerService: (port, handler) => node.registerService(port, context => {
      // Noise may expose either compressed parity for the same authenticated device.
      if (!closed) return handler({ ...context, src: normalizeDeviceSyncPeer(context.src) })
    }),
    async sendDatagram(args) {
      if (closed) return
      // FIPS datagrams can be lost; TCP owns retransmission. Bound outstanding
      // route lookups/sends rather than enqueueing an unbounded packet backlog.
      const dst = normalizeDeviceSyncPeer(args.dst)
      if (packets >= 256 || (perPeer.get(dst) ?? 0) >= 32 || bytes + args.payload.byteLength > 256 * 1024) return
      const size = args.payload.byteLength
      packets++; bytes += size; perPeer.set(dst, (perPeer.get(dst) ?? 0) + 1)
      void Promise.resolve().then(() => {
        // Teardown cancels work before handoff; FIPS owns already-started sends.
        if (!closed) return node.sendDatagram({ ...args, dst })
      }).catch(() => { /* A rejected datagram is packet loss; TCP retries it. */ })
        .finally(() => {
          packets--; bytes -= size
          const remaining = (perPeer.get(dst) ?? 1) - 1
          if (remaining) perPeer.set(dst, remaining); else perPeer.delete(dst)
        })
    },
  }
  return { endpoint, close: () => { closed = true } }
}

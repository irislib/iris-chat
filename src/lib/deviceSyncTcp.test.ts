import { describe, expect, it, vi } from 'vitest'
import type { FipsDatagramEndpoint, FipsServiceContext } from '@fips/tcp'
import { DeviceSyncTcp, RecordReader } from './deviceSyncTcp'

type Handler = (context: FipsServiceContext) => Promise<void> | void

class MemoryFipsEndpoint implements FipsDatagramEndpoint {
  private readonly handlers = new Map<number, Handler>()
  remote?: MemoryFipsEndpoint
  dropNext = false
  dropAll = false

  constructor(readonly id: string) {}

  registerService(port: number, handler: Handler): () => void {
    this.handlers.set(port, handler)
    return () => this.handlers.delete(port)
  }

  async sendDatagram(args: {
    dst: string
    srcPort?: number
    dstPort: number
    payload: Uint8Array
  }): Promise<void> {
    if (this.dropAll || this.dropNext) {
      this.dropNext = false
      return
    }
    if (this.remote?.id !== args.dst) throw new Error('unknown peer')
    const handler = this.remote.handlers.get(args.dstPort)
    if (!handler) throw new Error('missing service')
    queueMicrotask(() => void handler({
      src: this.id,
      srcPort: args.srcPort ?? 0,
      dstPort: args.dstPort,
      payload: args.payload.slice(),
    }))
  }
}

describe('DeviceSyncTcp', () => {
  it('reassembles split and coalesced records within the size bound', () => {
    const reader = new RecordReader(8)
    const framed = Uint8Array.from([0, 0, 0, 2, 1, 2, 0, 0, 0, 1, 3])
    expect(reader.push(framed.slice(0, 5))).toEqual([])
    expect(reader.push(framed.slice(5))).toEqual([
      Uint8Array.from([1, 2]),
      Uint8Array.from([3]),
    ])
    expect(() => reader.push(Uint8Array.from([0, 0, 0, 9]))).toThrow(/exceeds limit/)
  })

  it('delivers ordered records after loss and a stream reconnect', async () => {
    vi.useFakeTimers()
    const aEndpoint = new MemoryFipsEndpoint('a'.repeat(64))
    const bEndpoint = new MemoryFipsEndpoint('b'.repeat(64))
    aEndpoint.remote = bEndpoint
    bEndpoint.remote = aEndpoint
    const received: string[] = []
    const errors: Error[] = []
    const a = new DeviceSyncTcp({
      endpoint: aEndpoint,
      localPeer: aEndpoint.id,
      port: 7369,
      maxRecordBytes: 1024,
      onRecord: () => undefined,
      onError: (error) => errors.push(error),
      isnSeed: 1n,
    })
    const b = new DeviceSyncTcp({
      endpoint: bEndpoint,
      localPeer: bEndpoint.id,
      port: 7369,
      maxRecordBytes: 1024,
      onRecord: (_peer, bytes) => {
        received.push(new TextDecoder().decode(bytes))
      },
      onError: (error) => errors.push(error),
      isnSeed: 2n,
    })
    try {
      await bEndpoint.sendDatagram({
        dst: aEndpoint.id,
        srcPort: 7369,
        dstPort: 7369,
        payload: new TextEncoder().encode('{"type":"request","v":1}'),
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(errors).toHaveLength(1)
      errors.length = 0
      a.setPeer(bEndpoint.id, true)
      b.setPeer(aEndpoint.id, true)
      await vi.advanceTimersByTimeAsync(100)
      aEndpoint.dropNext = true
      const sends = [a.send(bEndpoint.id, new TextEncoder().encode('one')),
        a.send(bEndpoint.id, new TextEncoder().encode('two'))]
      await vi.advanceTimersByTimeAsync(2_000)
      await Promise.all(sends)
      expect(received).toEqual(['one', 'two'])
      a.setPeer(bEndpoint.id, false)
      b.setPeer(aEndpoint.id, false)
      await vi.advanceTimersByTimeAsync(100)
      a.setPeer(bEndpoint.id, true)
      b.setPeer(aEndpoint.id, true)
      const reconnected = a.send(bEndpoint.id, new TextEncoder().encode('three'))
      await vi.advanceTimersByTimeAsync(2_000)
      await reconnected
      expect(received).toEqual(['one', 'two', 'three'])
      expect(errors).toEqual([])
    } finally {
      await Promise.all([a.dispose(), b.dispose()])
      vi.useRealTimers()
    }
  })

  it('runs anti-entropy again after TCP exhausts retries and reconnects', async () => {
    vi.useFakeTimers()
    const aEndpoint = new MemoryFipsEndpoint('a'.repeat(64))
    const bEndpoint = new MemoryFipsEndpoint('b'.repeat(64))
    aEndpoint.remote = bEndpoint
    bEndpoint.remote = aEndpoint
    const received: string[] = []
    let connected = 0
    let a: DeviceSyncTcp
    const tcpConfig = {
      initialRtoMs: 25,
      minRtoMs: 25,
      maxRtoMs: 25,
      maxRetransmissions: 1,
      timeWaitMs: 0,
    }
    a = new DeviceSyncTcp({
      endpoint: aEndpoint,
      localPeer: aEndpoint.id,
      port: 7369,
      maxRecordBytes: 1024,
      onRecord: () => undefined,
      onConnected: () => {
        connected += 1
        if (connected > 1) {
          void a.sendFirst(bEndpoint.id, new TextEncoder().encode('recover'))
        }
      },
      tcpConfig,
    })
    const b = new DeviceSyncTcp({
      endpoint: bEndpoint,
      localPeer: bEndpoint.id,
      port: 7369,
      maxRecordBytes: 1024,
      onRecord: (_peer, bytes) => {
        received.push(new TextDecoder().decode(bytes))
      },
      tcpConfig,
    })
    try {
      a.setPeer(bEndpoint.id, true)
      b.setPeer(aEndpoint.id, true)
      await vi.advanceTimersByTimeAsync(100)
      expect(connected).toBe(1)
      aEndpoint.dropAll = true
      await a.send(bEndpoint.id, new TextEncoder().encode('lost-with-stream'))
      await vi.advanceTimersByTimeAsync(250)
      aEndpoint.dropAll = false
      await vi.advanceTimersByTimeAsync(1_000)
      expect(connected).toBeGreaterThan(1)
      expect(received).toEqual(['recover'])
    } finally {
      await Promise.all([a.dispose(), b.dispose()])
      vi.useRealTimers()
    }
  })

  it('restarts a partially accepted frame from its header on a fresh stream', async () => {
    vi.useFakeTimers()
    const aEndpoint = new MemoryFipsEndpoint('a'.repeat(64))
    const bEndpoint = new MemoryFipsEndpoint('b'.repeat(64))
    aEndpoint.remote = bEndpoint
    bEndpoint.remote = aEndpoint
    const received: string[] = []
    const tcpConfig = { sendBuffer: 8, initialRtoMs: 25, minRtoMs: 25, maxRtoMs: 25 }
    const a = new DeviceSyncTcp({
      endpoint: aEndpoint,
      localPeer: aEndpoint.id,
      port: 7369,
      maxRecordBytes: 1024,
      onRecord: () => undefined,
      tcpConfig,
    })
    const b = new DeviceSyncTcp({
      endpoint: bEndpoint,
      localPeer: bEndpoint.id,
      port: 7369,
      maxRecordBytes: 1024,
      onRecord: (_peer, bytes) => {
        received.push(new TextDecoder().decode(bytes))
      },
      tcpConfig,
    })
    try {
      a.setPeer(bEndpoint.id, true)
      b.setPeer(aEndpoint.id, true)
      await vi.advanceTimersByTimeAsync(100)
      aEndpoint.dropAll = true
      const send = a.send(bEndpoint.id, new TextEncoder().encode('long-enough-to-be-partial'))
      await vi.advanceTimersByTimeAsync(50)
      a.setPeer(bEndpoint.id, false)
      b.setPeer(aEndpoint.id, false)
      await vi.advanceTimersByTimeAsync(50)
      aEndpoint.dropAll = false
      a.setPeer(bEndpoint.id, true)
      b.setPeer(aEndpoint.id, true)
      await vi.advanceTimersByTimeAsync(2_000)
      await send
      expect(received).toEqual(['long-enough-to-be-partial'])
    } finally {
      await Promise.all([a.dispose(), b.dispose()])
      vi.useRealTimers()
    }
  })

  it('lets an ordered record handler await a TCP response without deadlocking', async () => {
    vi.useFakeTimers()
    const aEndpoint = new MemoryFipsEndpoint('a'.repeat(64))
    const bEndpoint = new MemoryFipsEndpoint('b'.repeat(64))
    aEndpoint.remote = bEndpoint
    bEndpoint.remote = aEndpoint
    const received: string[] = []
    let b: DeviceSyncTcp
    const a = new DeviceSyncTcp({
      endpoint: aEndpoint,
      localPeer: aEndpoint.id,
      port: 7369,
      maxRecordBytes: 1024,
      onRecord: (_peer, bytes) => {
        received.push(new TextDecoder().decode(bytes))
      },
    })
    b = new DeviceSyncTcp({
      endpoint: bEndpoint,
      localPeer: bEndpoint.id,
      port: 7369,
      maxRecordBytes: 1024,
      onRecord: async (peer, bytes) => {
        if (new TextDecoder().decode(bytes) === 'request') {
          await b.send(peer, new TextEncoder().encode('response'))
        }
      },
    })
    try {
      a.setPeer(bEndpoint.id, true)
      b.setPeer(aEndpoint.id, true)
      await vi.advanceTimersByTimeAsync(100)
      const request = a.send(bEndpoint.id, new TextEncoder().encode('request'))
      await vi.advanceTimersByTimeAsync(1_000)
      await request
      expect(received).toEqual(['response'])
    } finally {
      await Promise.all([a.dispose(), b.dispose()])
      vi.useRealTimers()
    }
  })

  it('rejects new records when a disconnected peer queue reaches its bound', async () => {
    vi.useFakeTimers()
    const endpoint = new MemoryFipsEndpoint('a'.repeat(64))
    const tcp = new DeviceSyncTcp({
      endpoint,
      localPeer: endpoint.id,
      port: 7369,
      maxRecordBytes: 1024,
      onRecord: () => undefined,
    })
    const queued = Array.from({ length: 64 }, () =>
      tcp.send('b'.repeat(64), Uint8Array.of(1)).catch(() => undefined)
    )
    try {
      await expect(tcp.send('b'.repeat(64), Uint8Array.of(2))).rejects.toThrow(/queue is full/)
    } finally {
      await tcp.dispose()
      await Promise.all(queued)
      vi.useRealTimers()
    }
  })
})

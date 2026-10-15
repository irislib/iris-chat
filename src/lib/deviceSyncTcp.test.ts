import { describe, expect, it, vi } from 'vitest'
import { Flags, Segment, type FipsDatagramEndpoint, type FipsServiceContext } from '@fips/tcp'
import { DeviceSyncTcp, RecordReader, frameRecord } from './deviceSyncTcp'

type Handler = (context: FipsServiceContext) => Promise<void> | void

class MemoryFipsEndpoint implements FipsDatagramEndpoint {
  private readonly handlers = new Map<number, Handler>()
  remote?: MemoryFipsEndpoint
  dropNext = false
  dropAll = false
  sourceIdentity?: string
  held?: Array<() => void>
  holdOnly?: (payload: Uint8Array) => boolean

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
    const deliver = () => void handler({
      src: this.sourceIdentity ?? this.id,
      srcPort: args.srcPort ?? 0,
      dstPort: args.dstPort,
      payload: args.payload.slice(),
    })
    if (this.held && (!this.holdOnly || this.holdOnly(args.payload))) this.held.push(deliver)
    else queueMicrotask(deliver)
  }
}

describe('DeviceSyncTcp', () => {
  it('uses one stream identity when peer events and authenticated datagrams have different key parity', async () => {
    vi.useFakeTimers()
    const aEndpoint = new MemoryFipsEndpoint(`02${'a'.repeat(64)}`)
    const bEndpoint = new MemoryFipsEndpoint(`02${'b'.repeat(64)}`)
    aEndpoint.remote = bEndpoint
    bEndpoint.remote = aEndpoint
    bEndpoint.sourceIdentity = `03${'b'.repeat(64)}`
    const received: Array<[string, string]> = []
    const options = (endpoint: MemoryFipsEndpoint) => ({
      endpoint, localPeer: endpoint.id, port: 7369, maxRecordBytes: 1024,
      onRecord: (peer: string, bytes: Uint8Array) => { received.push([peer, new TextDecoder().decode(bytes)]) },
    })
    const a = new DeviceSyncTcp(options(aEndpoint))
    const b = new DeviceSyncTcp(options(bEndpoint))
    try {
      a.setPeer(bEndpoint.id, true)
      b.setPeer(aEndpoint.id, true)
      const sent = a.send(bEndpoint.id, new TextEncoder().encode('history')).catch(() => undefined)
      await vi.advanceTimersByTimeAsync(250)
      expect(received).toEqual([[aEndpoint.id, 'history']])
      await sent
      const reply = b.send(`03${'a'.repeat(64)}`, new TextEncoder().encode('reply')).catch(() => undefined)
      await vi.advanceTimersByTimeAsync(100)
      expect(received).toEqual([[aEndpoint.id, 'history'], [bEndpoint.id, 'reply']])
      await reply
      a.setPeer(bEndpoint.sourceIdentity, false)
      b.setPeer(aEndpoint.id, false)
      await vi.advanceTimersByTimeAsync(100)
      const pending = a.send(bEndpoint.id, new TextEncoder().encode('after reconnect')).catch(() => undefined)
      await vi.advanceTimersByTimeAsync(100)
      expect(received).toHaveLength(2)
      a.setPeer(bEndpoint.sourceIdentity, true)
      b.setPeer(`03${'a'.repeat(64)}`, true)
      await vi.advanceTimersByTimeAsync(250)
      expect(received.at(-1)).toEqual([aEndpoint.id, 'after reconnect'])
      await pending
    } finally {
      await Promise.all([a.dispose(), b.dispose()])
      vi.useRealTimers()
    }
  })

  it.each([false, true])('recovers a reloaded peer over a persistent carrier; reloaded peer is dialer=%s', async (reloadDialer: boolean) => {
    vi.useFakeTimers()
    const aEndpoint = new MemoryFipsEndpoint('a'.repeat(64))
    const bEndpoint = new MemoryFipsEndpoint('b'.repeat(64))
    aEndpoint.remote = bEndpoint
    bEndpoint.remote = aEndpoint
    const received: string[] = []
    const connected: string[] = []
    const options = (endpoint: MemoryFipsEndpoint) => ({
      endpoint, localPeer: endpoint.id, port: 7369, maxRecordBytes: 1024,
      onRecord: (_peer: string, bytes: Uint8Array) => { received.push(new TextDecoder().decode(bytes)) },
      onConnected: () => { connected.push(endpoint.id) },
    })
    let a = new DeviceSyncTcp(options(aEndpoint))
    let b = new DeviceSyncTcp(options(bEndpoint))
    try {
      a.setPeer(bEndpoint.id, true)
      b.setPeer(aEndpoint.id, true)
      const initial = a.send(bEndpoint.id, new TextEncoder().encode('before reload'))
      await vi.advanceTimersByTimeAsync(250)
      await initial
      expect(received).toEqual(['before reload'])
      // Abrupt page teardown drops TCP state, while the authenticated carrier
      // and remote endpoint keep their old Established stream.
      if (reloadDialer) { await a.dispose(); a = new DeviceSyncTcp(options(aEndpoint)); a.setPeer(bEndpoint.id, true) }
      else { await b.dispose(); b = new DeviceSyncTcp(options(bEndpoint)); b.setPeer(aEndpoint.id, true) }
      connected.length = 0
      const reloaded = reloadDialer ? a : b
      const peer = reloadDialer ? bEndpoint.id : aEndpoint.id
      const sent = reloaded.send(peer, new TextEncoder().encode('after reload')).catch(() => {})
      if (!reloadDialer) {
        await vi.advanceTimersByTimeAsync(1_000)
        expect(received).toEqual(['before reload'])
        expect(connected).toEqual([])
      }
      await vi.advanceTimersByTimeAsync(5_000)
      expect(received).toEqual(['before reload', 'after reload'])
      expect(connected).toContain(reloadDialer ? aEndpoint.id : bEndpoint.id)
      await sent
    } finally {
      await Promise.all([a.dispose(), b.dispose()])
      vi.useRealTimers()
    }
  })

  it('bounds passive recovery attempts and stops when the peer is no longer allowed', async () => {
    vi.useFakeTimers()
    const endpoint = new MemoryFipsEndpoint('b'.repeat(64))
    endpoint.dropAll = true
    const outgoing = vi.spyOn(endpoint, 'sendDatagram')
    const peer = 'a'.repeat(64)
    const tcp = new DeviceSyncTcp({ endpoint, localPeer: endpoint.id, port: 7369, maxRecordBytes: 1024,
      onRecord: () => undefined,
      tcpConfig: { initialRtoMs: 25, minRtoMs: 25, maxRtoMs: 25, maxRetransmissions: 1 },
    })
    const attempts = () => {
      const segments: Segment[] = outgoing.mock.calls.map(([args]: Parameters<MemoryFipsEndpoint['sendDatagram']>) => Segment.decode(args.payload))
      return new Set(segments.filter(segment => segment.flags.has(Flags.Syn)).map(segment => segment.srcPort)).size
    }
    try {
      const pending = tcp.send(peer, new TextEncoder().encode('pending')).catch(() => undefined)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(attempts()).toBe(0) // Queuing a record does not authorize its recipient.
      tcp.setPeer(peer, true)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(attempts()).toBe(3) // 2s grace, then 4s and 8s retry delays.
      tcp.setPeer(peer, false)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(attempts()).toBe(3)
      await tcp.dispose()
      await pending
    } finally {
      await tcp.dispose()
      vi.useRealTimers()
    }
  })

  it.each([[false, false], [true, false], [false, true], [true, true]])('settles crossing handshakes; higher-first=%s, delayed final ACK=%s', async (higherFirst: boolean, delayedAck: boolean) => {
    vi.useFakeTimers()
    const aEndpoint = new MemoryFipsEndpoint('a'.repeat(64)), bEndpoint = new MemoryFipsEndpoint('b'.repeat(64))
    aEndpoint.remote = bEndpoint; bEndpoint.remote = aEndpoint
    const held: Array<() => void> = []
    aEndpoint.held = held; bEndpoint.held = held
    const received: string[] = [], connected: string[] = []
    const options = (endpoint: MemoryFipsEndpoint) => ({ endpoint, localPeer: endpoint.id, port: 7369, maxRecordBytes: 1024,
      onRecord: (_peer: string, bytes: Uint8Array) => { received.push(new TextDecoder().decode(bytes)) },
      onConnected: () => { connected.push(endpoint.id) },
    })
    const first = new DeviceSyncTcp(options(higherFirst ? bEndpoint : aEndpoint))
    const second = new DeviceSyncTcp(options(higherFirst ? aEndpoint : bEndpoint))
    const a = higherFirst ? second : first, b = higherFirst ? first : second
    try {
      a.setPeer(bEndpoint.id, true); b.setPeer(aEndpoint.id, true)
      const sends = [a.send(bEndpoint.id, new TextEncoder().encode('from a')).catch(() => {}),
        b.send(aEndpoint.id, new TextEncoder().encode('from b')).catch(() => {})]
      // Routing can delay the original SYN beyond the passive recovery grace.
      await vi.advanceTimersByTimeAsync(2_100)
      aEndpoint.held = undefined; bEndpoint.held = undefined
      const late: Array<() => void> = []
      if (delayedAck) {
        bEndpoint.held = late
        bEndpoint.holdOnly = payload => {
          const segment = Segment.decode(payload)
          return segment.srcPort !== 7369 && segment.flags.has(Flags.Ack) && !segment.flags.has(Flags.Syn)
        }
      }
      for (const deliver of held) deliver()
      if (delayedAck) {
        await vi.advanceTimersByTimeAsync(250)
        expect(late.length).toBeGreaterThan(0)
        expect(connected).toContain(aEndpoint.id)
        bEndpoint.held = undefined
        for (const deliver of late) deliver()
      }
      await vi.advanceTimersByTimeAsync(1_000)
      expect(received.sort()).toEqual(['from a', 'from b'])
      expect([...new Set(connected)].sort()).toEqual([aEndpoint.id, bEndpoint.id])
      expect(connected.length).toBeLessThanOrEqual(4)
      const settled = connected.length
      await vi.advanceTimersByTimeAsync(5_000)
      expect(connected.length).toBe(settled)
      expect(received.sort()).toEqual(['from a', 'from b'])
      await Promise.all(sends)
    } finally {
      await Promise.all([a.dispose(), b.dispose()]); vi.useRealTimers()
    }
  })

  it('keeps a canonical SYN in flight and never writes app records on a recovery probe', async () => {
    vi.useFakeTimers()
    const aEndpoint = new MemoryFipsEndpoint('a'.repeat(64)), bEndpoint = new MemoryFipsEndpoint('b'.repeat(64))
    aEndpoint.remote = bEndpoint; bEndpoint.remote = aEndpoint
    const held: Array<() => void> = []
    aEndpoint.held = held
    aEndpoint.holdOnly = payload => {
      const flags = Segment.decode(payload).flags
      return flags.has(Flags.Syn) && !flags.has(Flags.Ack)
    }
    const received: string[] = [], connected: string[] = []
    const options = (endpoint: MemoryFipsEndpoint) => ({ endpoint, localPeer: endpoint.id, port: 7369, maxRecordBytes: 1024,
      onRecord: (_peer: string, bytes: Uint8Array) => { received.push(new TextDecoder().decode(bytes)) },
      onConnected: () => { connected.push(endpoint.id) },
    })
    const a = new DeviceSyncTcp(options(aEndpoint)), b = new DeviceSyncTcp(options(bEndpoint))
    try {
      a.setPeer(bEndpoint.id, true); b.setPeer(aEndpoint.id, true)
      const sends = [a.send(bEndpoint.id, new TextEncoder().encode('from a')).catch(() => {}),
        b.send(aEndpoint.id, new TextEncoder().encode('from b')).catch(() => {})]
      await vi.advanceTimersByTimeAsync(2_100)
      expect(connected).toEqual([])
      expect(received).toEqual([])
      aEndpoint.held = undefined
      for (const deliver of held) deliver()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(connected.sort()).toEqual([aEndpoint.id, bEndpoint.id])
      expect(received.sort()).toEqual(['from a', 'from b'])
      await Promise.all(sends)
    } finally {
      await Promise.all([a.dispose(), b.dispose()]); vi.useRealTimers()
    }
  })

  it('delivers an acknowledged complete frame before retiring a peer-closed stream', async () => {
    vi.useFakeTimers()
    const aEndpoint = new MemoryFipsEndpoint('a'.repeat(64)), bEndpoint = new MemoryFipsEndpoint('b'.repeat(64))
    aEndpoint.remote = bEndpoint; bEndpoint.remote = aEndpoint
    const received: string[] = []
    const options = (endpoint: MemoryFipsEndpoint) => ({ endpoint, localPeer: endpoint.id, port: 7369, maxRecordBytes: 1024,
      onRecord: (_peer: string, bytes: Uint8Array) => { received.push(new TextDecoder().decode(bytes)) },
    })
    const a = new DeviceSyncTcp(options(aEndpoint)), b = new DeviceSyncTcp(options(bEndpoint))
    try {
      a.setPeer(bEndpoint.id, true); b.setPeer(aEndpoint.id, true)
      await vi.advanceTimersByTimeAsync(100)
      const sent = a.send(bEndpoint.id, new TextEncoder().encode('final frame'))
      await vi.advanceTimersByTimeAsync(0)
      await sent
      expect(received).toEqual([])
      a.setPeer(bEndpoint.id, false)
      await vi.advanceTimersByTimeAsync(25)
      expect(received).toEqual(['final frame'])
    } finally {
      await Promise.all([a.dispose(), b.dispose()]); vi.useRealTimers()
    }
  })

  it('delivers an acknowledged unread frame before accepting a reconnected canonical dialer', async () => {
    vi.useFakeTimers()
    const aEndpoint = new MemoryFipsEndpoint('a'.repeat(64)), bEndpoint = new MemoryFipsEndpoint('b'.repeat(64))
    aEndpoint.remote = bEndpoint; bEndpoint.remote = aEndpoint
    const received: string[] = []
    const options = (endpoint: MemoryFipsEndpoint) => ({ endpoint, localPeer: endpoint.id, port: 7369, maxRecordBytes: 1024,
      onRecord: (_peer: string, bytes: Uint8Array) => { received.push(new TextDecoder().decode(bytes)) },
    })
    const a = new DeviceSyncTcp(options(aEndpoint))
    const b = new DeviceSyncTcp(options(bEndpoint))
    try {
      a.setPeer(bEndpoint.id, true); b.setPeer(aEndpoint.id, true)
      await vi.advanceTimersByTimeAsync(100)
      const sent = a.send(bEndpoint.id, new TextEncoder().encode('before reload'))
      await vi.advanceTimersByTimeAsync(0)
      await sent
      expect(received).toEqual([])
      a.setPeer(bEndpoint.id, false)
      a.setPeer(bEndpoint.id, true)
      const next = a.send(bEndpoint.id, new TextEncoder().encode('after reload')).catch(() => {})
      await vi.advanceTimersByTimeAsync(250)
      expect(received).toEqual(['before reload', 'after reload'])
      await next
    } finally {
      await Promise.all([a.dispose(), b.dispose()]); vi.useRealTimers()
    }
  })

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

  it('uses u32-BE framing and rejects truncated streams', () => {
    expect(frameRecord(Uint8Array.of(1, 2, 3))).toEqual(
      Uint8Array.of(0, 0, 0, 3, 1, 2, 3),
    )
    const reader = new RecordReader(64 * 1024)
    expect(reader.push(Uint8Array.of(0, 0, 0, 3, 1))).toEqual([])
    expect(() => reader.finish()).toThrow(/truncated/)
  })

  it('accepts an exact 64 KiB record and rejects a larger frame before delivery', () => {
    const reader = new RecordReader(64 * 1024)
    const exact = new Uint8Array(64 * 1024)
    expect(reader.push(frameRecord(exact))).toEqual([exact])
    expect(() => reader.push(Uint8Array.of(0, 1, 0, 1))).toThrow(/exceeds limit/)
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
      const lost = a.send(bEndpoint.id, new TextEncoder().encode('lost-with-stream')).catch(() => undefined)
      await vi.advanceTimersByTimeAsync(250)
      aEndpoint.dropAll = false
      await vi.advanceTimersByTimeAsync(1_000)
      expect(connected).toBeGreaterThan(1)
      expect(received).toEqual(['recover', 'lost-with-stream'])
      await lost
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

  it('keeps priority control behind a partially written record', async () => {
    vi.useFakeTimers()
    const aEndpoint = new MemoryFipsEndpoint('a'.repeat(64))
    const bEndpoint = new MemoryFipsEndpoint('b'.repeat(64))
    aEndpoint.remote = bEndpoint
    bEndpoint.remote = aEndpoint
    const received: string[] = []
    const errors: Error[] = []
    const tcpConfig = { sendBuffer: 8, initialRtoMs: 25, minRtoMs: 25, maxRtoMs: 25 }
    const a = new DeviceSyncTcp({
      endpoint: aEndpoint,
      localPeer: aEndpoint.id,
      port: 7369,
      maxRecordBytes: 1024,
      onRecord: () => undefined,
      onError: (error) => errors.push(error),
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
      onError: (error) => errors.push(error),
      tcpConfig,
    })
    try {
      a.setPeer(bEndpoint.id, true)
      b.setPeer(aEndpoint.id, true)
      await vi.advanceTimersByTimeAsync(100)
      aEndpoint.dropAll = true
      const original = a.send(bEndpoint.id, new TextEncoder().encode('long-enough-to-be-partial'))
      await vi.advanceTimersByTimeAsync(50)
      const control = a.sendFirst(bEndpoint.id, new TextEncoder().encode('control'))
      aEndpoint.dropAll = false
      await vi.advanceTimersByTimeAsync(2_000)
      await Promise.all([original, control])
      expect(received).toEqual(['long-enough-to-be-partial', 'control'])
      expect(errors).toEqual([])
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

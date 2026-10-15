import {
  FipsTcpEndpoint,
  MarkerStatus,
  State,
  type SendMarker,
  type Config,
  type ConnectionId,
  type FipsDatagramEndpoint,
} from '@fips/tcp'

const POLL_MS = 25
const PASSIVE_DIAL_GRACE_MS = 2_000
const MAX_PASSIVE_DIAL_DELAY_MS = 30_000
const FRAME_HEADER_BYTES = 4
const MAX_PENDING_RECORDS_PER_PEER = 64
const MAX_PENDING_BYTES_PER_PEER = 4 * 1024 * 1024
const MAX_PENDING_BYTES_TOTAL = 16 * 1024 * 1024

interface PendingWrite {
  bytes: Uint8Array
  offset: number
  marker?: SendMarker
  resolve: () => void
  reject: (error: Error) => void
}

export interface DeviceSyncTcpOptions {
  endpoint: FipsDatagramEndpoint
  localPeer: string
  port: number
  maxRecordBytes: number
  onRecord: (peer: string, record: Uint8Array) => Promise<void> | void
  onConnected?: (peer: string) => void
  onError?: (error: Error) => void
  isnSeed?: bigint | number
  tcpConfig?: Partial<Config>
}

/** Reliable, framed linked-device records over one TCP/FIPS stream per peer. */
export class DeviceSyncTcp {
  private readonly tcp: FipsTcpEndpoint
  private readonly peers = new Set<string>()
  private readonly passiveDials = new Map<string, { after: number; delay: number }>()
  private readonly connections = new Map<string, ConnectionId>()
  private readonly established = new Set<ConnectionId>()
  private readonly probes = new Set<ConnectionId>()
  private readonly readers = new Map<ConnectionId, RecordReader>()
  private readonly pending = new Map<string, PendingWrite[]>()
  private readonly pendingBytesByPeer = new Map<string, number>()
  private readonly timer: ReturnType<typeof setInterval>
  private operation: Promise<void> = Promise.resolve()
  private deliveries: Promise<void> = Promise.resolve()
  private pendingBytes = 0
  private stopped = false

  constructor(private readonly options: DeviceSyncTcpOptions) {
    const endpoint: FipsDatagramEndpoint = {
      registerService: (port, handler) => options.endpoint.registerService(port, context =>
        handler({ ...context, src: normalizeDeviceSyncPeer(context.src) })),
      sendDatagram: args => options.endpoint.sendDatagram({ ...args, dst: normalizeDeviceSyncPeer(args.dst) }),
    }
    this.tcp = new FipsTcpEndpoint(endpoint, options.port, {
      mss: 1024,
      receiveBuffer: 0xffff,
      sendBuffer: 1024 * 1024,
      maxConnections: 64,
      maxReassemblySegments: 128,
      ...options.tcpConfig,
    }, options.isnSeed ?? 1n)
    this.timer = setInterval(() => {
      void this.enqueue(() => this.tick()).catch((error) => this.report(error))
    }, POLL_MS)
  }

  setPeer(peer: string, connected: boolean): void {
    peer = normalizeDeviceSyncPeer(peer)
    void this.enqueue(async () => {
      if (connected) this.peers.add(peer)
      else {
        this.peers.delete(peer)
        this.passiveDials.delete(peer)
        const id = this.connections.get(peer)
        if (id !== undefined) {
          try {
            await this.tcp.close(id)
          } catch {
            // A half-open stream can already have disappeared from the stack.
          }
          this.removeConnection(peer, id)
        }
      }
      await this.ensureConnections()
    }).catch((error) => this.report(error))
  }

  send(peer: string, record: Uint8Array): Promise<void> {
    return this.queueRecord(peer, record, false)
  }

  sendFirst(peer: string, record: Uint8Array): Promise<void> {
    return this.queueRecord(peer, record, true)
  }

  private queueRecord(peer: string, record: Uint8Array, first: boolean): Promise<void> {
    peer = normalizeDeviceSyncPeer(peer)
    if (this.stopped) return Promise.reject(new Error('device sync TCP is stopped'))
    if (record.byteLength > this.options.maxRecordBytes) {
      return Promise.reject(new Error('device sync record exceeds the configured limit'))
    }
    return new Promise<void>((resolve, reject) => {
      const writes = this.pending.get(peer) ?? []
      const bytes = frameRecord(record)
      if (first) this.makeRoomForPriority(peer, writes, bytes.byteLength)
      if (this.exceedsPendingLimit(peer, writes.length, bytes.byteLength)) {
        reject(new Error('device sync TCP pending queue is full'))
        return
      }
      const write = { bytes, offset: 0, resolve, reject }
      if (first) writes.splice(writes[0]?.offset ? 1 : 0, 0, write)
      else writes.push(write)
      this.pending.set(peer, writes)
      this.addPendingBytes(peer, bytes.byteLength)
      void this.enqueue(async () => {
        await this.ensureConnections()
        await this.progress()
      }).catch((error) => this.report(error))
    })
  }

  async dispose(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    await this.operation
    for (const [peer, id] of this.connections) this.removeConnection(peer, id)
    await this.tcp.dispose()
    await this.deliveries
    const error = new Error('device sync TCP stopped before queued data was sent')
    for (const writes of this.pending.values()) {
      for (const write of writes) write.reject(error)
    }
    this.pending.clear()
    this.passiveDials.clear()
    this.pendingBytesByPeer.clear()
    this.pendingBytes = 0
  }

  private async tick(): Promise<void> {
    await this.tcp.poll()
    for (const [peer, id] of [...this.connections]) {
      if (await this.tcp.state(id) !== undefined) continue
      this.removeConnection(peer, id)
    }
    await this.ensureConnections()
    await this.progress()
  }

  private async ensureConnections(): Promise<void> {
    for (const peer of this.peers) {
      if (this.connections.has(peer)) continue
      if (!shouldInitiate(this.options.localPeer, peer)) {
        // A routed peer can retain its old stream when this page reloads. Give
        // the normal dialer priority, then recover pending writes ourselves.
        // Only configured peers are eligible; failed probes back off per peer.
        if (!this.pending.get(peer)?.length) continue
        const now = Date.now()
        const retry = this.passiveDials.get(peer) ?? { after: now + PASSIVE_DIAL_GRACE_MS, delay: PASSIVE_DIAL_GRACE_MS }
        this.passiveDials.set(peer, retry)
        if (now < retry.after) continue
        retry.delay = Math.min(MAX_PASSIVE_DIAL_DELAY_MS, retry.delay * 2)
        retry.after = now + retry.delay
      }
      const id = await this.tcp.connect(peer)
      if (!shouldInitiate(this.options.localPeer, peer)) this.probes.add(id)
      this.connections.set(peer, id)
      this.readers.set(id, new RecordReader(this.options.maxRecordBytes))
    }
  }

  private async progress(): Promise<void> {
    await this.acceptConnections()
    for (const [peer, id] of [...this.connections]) {
      const state = await this.tcp.state(id)
      if (state === State.CloseWait) {
        if (!this.probes.has(id)) await this.drainReads(peer, id)
        await this.tcp.close(id)
        this.removeConnection(peer, id)
        continue
      }
      if (state !== State.Established) continue
      if (!this.probes.has(id) && !this.established.has(id)) {
        this.established.add(id)
        try {
          this.options.onConnected?.(peer)
        } catch (error) {
          this.report(error)
        }
      }
      if (!this.probes.has(id)) {
        await this.drainWrites(peer, id)
        await this.drainReads(peer, id)
      }
      if (await this.tcp.isReadClosed(id)) {
        try {
          await this.tcp.close(id)
        } catch {
          // The peer may have completed shutdown while its final bytes were read.
        }
        this.removeConnection(peer, id)
      }
    }
  }

  private async acceptConnections(): Promise<void> {
    for (;;) {
      const id = await this.tcp.accept()
      if (id === undefined) return
      const peer = await this.tcp.peer(id)
      if (peer === undefined || !this.peers.has(peer)) {
        await this.tcp.close(id)
        continue
      }
      const previous = this.connections.get(peer)
      if (shouldInitiate(this.options.localPeer, peer)) {
        // A higher-key recovery handshake wakes the canonical dialer; it never
        // becomes an app stream. This also resolves crossing handshakes after
        // either endpoint has observed Established, without timing heuristics.
        await this.tcp.abort(id)
        if (previous !== undefined && await this.tcp.state(previous) !== State.SynSent) {
          await this.drainReads(peer, previous)
          await this.tcp.abort(previous)
          this.removeConnection(peer, previous)
        }
        continue
      }
      if (previous !== undefined && previous !== id) {
        await this.tcp.abort(previous)
        this.removeConnection(peer, previous)
      }
      this.connections.set(peer, id)
      this.readers.set(id, new RecordReader(this.options.maxRecordBytes))
    }
  }

  private async drainWrites(peer: string, id: ConnectionId): Promise<void> {
    const writes = this.pending.get(peer)
    while (writes?.[0]) {
      const write = writes[0]
      if (write.marker) {
        const status = await this.tcp.markerStatus(write.marker)
        if (status === MarkerStatus.Acked && write.offset === write.bytes.byteLength) {
          writes.shift()
          this.removePendingBytes(peer, write.bytes.byteLength)
          write.resolve()
          continue
        }
        if (status === MarkerStatus.ConnectionGone) {
          write.offset = 0
          write.marker = undefined
        }
      }
      if (write.offset === write.bytes.byteLength) break
      const { accepted, marker } = await this.tcp.writeWithMarker(id, write.bytes.subarray(write.offset))
      if (accepted === 0) break
      write.offset += accepted
      write.marker = marker
      if (write.offset < write.bytes.byteLength) break
    }
    if (writes?.length === 0) this.pending.delete(peer)
  }

  private async drainReads(peer: string, id: ConnectionId): Promise<void> {
    const reader = this.readers.get(id)
    if (!reader) return
    for (;;) {
      const bytes = await this.tcp.read(id, 0xffff)
      if (bytes.byteLength === 0) return
      let records: Uint8Array[]
      try {
        records = reader.push(bytes)
      } catch (error) {
        try {
          await this.tcp.close(id)
        } catch {
          // The malformed stream may already have been reset.
        }
        this.removeConnection(peer, id, false)
        throw error
      }
      if (records.length) this.passiveDials.delete(peer)
      for (const record of records) this.deliver(peer, record)
    }
  }

  private enqueue(work: () => Promise<void> | void): Promise<void> {
    const result = this.operation.then(work, work)
    this.operation = result.catch(() => undefined)
    return result
  }

  private report(error: unknown): void {
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)))
  }

  private deliver(peer: string, record: Uint8Array): void {
    const delivery = this.deliveries.then(() => this.options.onRecord(peer, record))
    this.deliveries = delivery.catch((error) => this.report(error))
  }

  private removeConnection(peer: string, id: ConnectionId, checkReader = true): void {
    if (this.connections.get(peer) === id) this.connections.delete(peer)
    this.established.delete(id)
    this.probes.delete(id)
    const reader = this.readers.get(id)
    this.readers.delete(id)
    if (checkReader && reader) {
      try {
        reader.finish()
      } catch (error) {
        this.report(error)
      }
    }
    this.rewindPending(peer)
  }

  private rewindPending(peer: string): void {
    for (const write of this.pending.get(peer) ?? []) { write.offset = 0; write.marker = undefined }
  }

  private exceedsPendingLimit(peer: string, count: number, addedBytes: number): boolean {
    return count >= MAX_PENDING_RECORDS_PER_PEER ||
      (this.pendingBytesByPeer.get(peer) ?? 0) + addedBytes > MAX_PENDING_BYTES_PER_PEER ||
      this.pendingBytes + addedBytes > MAX_PENDING_BYTES_TOTAL
  }

  private makeRoomForPriority(peer: string, writes: PendingWrite[], addedBytes: number): void {
    while (this.exceedsPendingLimit(peer, writes.length, addedBytes)) {
      const evicted = writes.at(-1)
      if (!evicted || evicted.offset !== 0) return
      writes.pop()
      this.removePendingBytes(peer, evicted.bytes.byteLength)
      evicted.reject(new Error('device sync snapshot superseded by reconnect reconciliation'))
    }
  }

  private addPendingBytes(peer: string, bytes: number): void {
    this.pendingBytes += bytes
    this.pendingBytesByPeer.set(peer, (this.pendingBytesByPeer.get(peer) ?? 0) + bytes)
  }

  private removePendingBytes(peer: string, bytes: number): void {
    this.pendingBytes = Math.max(0, this.pendingBytes - bytes)
    const remaining = Math.max(0, (this.pendingBytesByPeer.get(peer) ?? 0) - bytes)
    if (remaining === 0) this.pendingBytesByPeer.delete(peer)
    else this.pendingBytesByPeer.set(peer, remaining)
  }
}

/** FIPS identifies a device by its x-only key; Noise can expose either parity. */
export function normalizeDeviceSyncPeer(peer: string): string {
  const normalized = peer.toLowerCase()
  return /^(02|03)[0-9a-f]{64}$/.test(normalized) ? `02${normalized.slice(2)}` : peer
}

export class RecordReader {
  private bytes = new Uint8Array()

  constructor(private readonly maxRecordBytes: number) {}

  push(chunk: Uint8Array): Uint8Array[] {
    const joined = new Uint8Array(this.bytes.byteLength + chunk.byteLength)
    joined.set(this.bytes)
    joined.set(chunk, this.bytes.byteLength)
    const records: Uint8Array[] = []
    let offset = 0
    while (joined.byteLength - offset >= FRAME_HEADER_BYTES) {
      const view = new DataView(joined.buffer, joined.byteOffset + offset, FRAME_HEADER_BYTES)
      const length = view.getUint32(0)
      if (length > this.maxRecordBytes) throw new Error('device sync TCP record exceeds limit')
      if (joined.byteLength - offset - FRAME_HEADER_BYTES < length) break
      const start = offset + FRAME_HEADER_BYTES
      records.push(joined.slice(start, start + length))
      offset = start + length
    }
    this.bytes = joined.slice(offset)
    return records
  }

  finish(): void {
    if (this.bytes.byteLength !== 0) {
      throw new Error('device sync TCP stream ended with a truncated record')
    }
  }
}

export function frameRecord(record: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(FRAME_HEADER_BYTES + record.byteLength)
  new DataView(bytes.buffer).setUint32(0, record.byteLength)
  bytes.set(record, FRAME_HEADER_BYTES)
  return bytes
}

function shouldInitiate(local: string, remote: string): boolean {
  return comparisonKey(local) < comparisonKey(remote)
}

function comparisonKey(peer: string): string {
  const normalized = peer.toLowerCase()
  return normalized.length === 66 && /^(02|03)/.test(normalized)
    ? normalized.slice(2)
    : normalized
}

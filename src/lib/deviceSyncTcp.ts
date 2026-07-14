import {
  Stack,
  State,
  type Config,
  type ConnectionId,
  type FipsDatagramEndpoint,
} from '@fips/tcp'

const POLL_MS = 25
const FRAME_HEADER_BYTES = 4
const MAX_PENDING_RECORDS_PER_PEER = 64
const MAX_PENDING_BYTES_PER_PEER = 4 * 1024 * 1024
const MAX_PENDING_BYTES_TOTAL = 16 * 1024 * 1024

interface PendingWrite {
  bytes: Uint8Array
  offset: number
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
  private readonly stack: Stack
  private readonly peers = new Set<string>()
  private readonly connections = new Map<string, ConnectionId>()
  private readonly established = new Set<ConnectionId>()
  private readonly readers = new Map<ConnectionId, RecordReader>()
  private readonly pending = new Map<string, PendingWrite[]>()
  private readonly pendingBytesByPeer = new Map<string, number>()
  private readonly unregister: () => void
  private readonly timer: ReturnType<typeof setInterval>
  private operation: Promise<void> = Promise.resolve()
  private deliveries: Promise<void> = Promise.resolve()
  private pendingBytes = 0
  private stopped = false

  constructor(private readonly options: DeviceSyncTcpOptions) {
    this.stack = new Stack({
      mss: 1024,
      receiveBuffer: 0xffff,
      sendBuffer: 1024 * 1024,
      maxConnections: 64,
      maxReassemblySegments: 128,
      ...options.tcpConfig,
    }, options.isnSeed)
    this.stack.listen(options.port)
    this.unregister = options.endpoint.registerService(options.port, (context) => {
      void this.enqueue(async () => {
        this.stack.input(context.src, context.payload, Date.now())
        await this.progress()
      }).catch((error) => this.report(error))
    })
    this.timer = setInterval(() => {
      void this.enqueue(() => this.tick()).catch((error) => this.report(error))
    }, POLL_MS)
  }

  setPeer(peer: string, connected: boolean): void {
    void this.enqueue(async () => {
      if (connected) this.peers.add(peer)
      else {
        this.peers.delete(peer)
        const id = this.connections.get(peer)
        if (id !== undefined) {
          try {
            this.stack.close(id, Date.now())
          } catch {
            // A half-open stream can already have disappeared from the stack.
          }
          this.connections.delete(peer)
          this.established.delete(id)
          this.readers.delete(id)
          this.rewindPending(peer)
        }
      }
      await this.ensureConnections()
      await this.flush()
    }).catch((error) => this.report(error))
  }

  send(peer: string, record: Uint8Array): Promise<void> {
    return this.queueRecord(peer, record, false)
  }

  sendFirst(peer: string, record: Uint8Array): Promise<void> {
    return this.queueRecord(peer, record, true)
  }

  private queueRecord(peer: string, record: Uint8Array, first: boolean): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('device sync TCP is stopped'))
    if (record.byteLength > this.options.maxRecordBytes) {
      return Promise.reject(new Error('device sync record exceeds the configured limit'))
    }
    return new Promise<void>((resolve, reject) => {
      const writes = this.pending.get(peer) ?? []
      const bytes = frame(record)
      if (first) this.makeRoomForPriority(peer, writes, bytes.byteLength)
      if (this.exceedsPendingLimit(peer, writes.length, bytes.byteLength)) {
        reject(new Error('device sync TCP pending queue is full'))
        return
      }
      const write = { bytes, offset: 0, resolve, reject }
      if (first) writes.unshift(write)
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
    this.unregister()
    await this.deliveries
    const error = new Error('device sync TCP stopped before queued data was sent')
    for (const writes of this.pending.values()) {
      for (const write of writes) write.reject(error)
    }
    this.pending.clear()
    this.pendingBytesByPeer.clear()
    this.pendingBytes = 0
  }

  private async tick(): Promise<void> {
    const now = Date.now()
    this.stack.poll(now)
    for (const [peer, id] of [...this.connections]) {
      if (this.stack.state(id) !== undefined) continue
      this.connections.delete(peer)
      this.established.delete(id)
      this.readers.delete(id)
      this.rewindPending(peer)
    }
    await this.ensureConnections()
    await this.progress()
  }

  private async ensureConnections(): Promise<void> {
    for (const peer of this.peers) {
      if (this.connections.has(peer) || !shouldInitiate(this.options.localPeer, peer)) continue
      const id = this.stack.connect(peer, this.options.port, Date.now())
      this.connections.set(peer, id)
      this.readers.set(id, new RecordReader(this.options.maxRecordBytes))
    }
    await this.flush()
  }

  private async progress(): Promise<void> {
    this.acceptConnections()
    for (const [peer, id] of [...this.connections]) {
      if (this.stack.state(id) !== State.Established) continue
      if (!this.established.has(id)) {
        this.established.add(id)
        try {
          this.options.onConnected?.(peer)
        } catch (error) {
          this.report(error)
        }
      }
      this.drainWrites(peer, id)
      await this.drainReads(peer, id)
    }
    await this.flush()
  }

  private acceptConnections(): void {
    for (;;) {
      const id = this.stack.accept(this.options.port)
      if (id === undefined) return
      const peer = this.stack.peer(id)
      if (peer === undefined || !this.peers.has(peer)) {
        this.stack.close(id, Date.now())
        continue
      }
      const previous = this.connections.get(peer)
      if (previous !== undefined && previous !== id) {
        this.stack.close(previous, Date.now())
        this.established.delete(previous)
        this.readers.delete(previous)
        this.rewindPending(peer)
      }
      this.connections.set(peer, id)
      this.readers.set(id, new RecordReader(this.options.maxRecordBytes))
    }
  }

  private drainWrites(peer: string, id: ConnectionId): void {
    const writes = this.pending.get(peer)
    while (writes?.[0]) {
      const write = writes[0]
      const accepted = this.stack.write(id, write.bytes.subarray(write.offset), Date.now())
      if (accepted === 0) break
      write.offset += accepted
      if (write.offset < write.bytes.byteLength) break
      writes.shift()
      this.removePendingBytes(peer, write.bytes.byteLength)
      write.resolve()
    }
    if (writes?.length === 0) this.pending.delete(peer)
  }

  private async drainReads(peer: string, id: ConnectionId): Promise<void> {
    const reader = this.readers.get(id)
    if (!reader) return
    for (;;) {
      const bytes = this.stack.read(id, 0xffff, Date.now())
      if (bytes.byteLength === 0) return
      let records: Uint8Array[]
      try {
        records = reader.push(bytes)
      } catch (error) {
        try {
          this.stack.close(id, Date.now())
        } catch {
          // The malformed stream may already have been reset.
        }
        this.connections.delete(peer)
        this.established.delete(id)
        this.readers.delete(id)
        throw error
      }
      for (const record of records) this.deliver(peer, record)
    }
  }

  private async flush(): Promise<void> {
    for (const outbound of this.stack.drainOutbound()) {
      await this.options.endpoint.sendDatagram({
        dst: outbound.peer,
        srcPort: this.options.port,
        dstPort: this.options.port,
        payload: outbound.bytes,
      })
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

  private rewindPending(peer: string): void {
    for (const write of this.pending.get(peer) ?? []) write.offset = 0
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
}

function frame(record: Uint8Array): Uint8Array {
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

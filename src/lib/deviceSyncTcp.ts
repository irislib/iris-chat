import {
  FipsTcpEndpoint,
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
  private readonly tcp: FipsTcpEndpoint
  private readonly peers = new Set<string>()
  private readonly connections = new Map<string, ConnectionId>()
  private readonly established = new Set<ConnectionId>()
  private readonly readers = new Map<ConnectionId, RecordReader>()
  private readonly pending = new Map<string, PendingWrite[]>()
  private readonly pendingBytesByPeer = new Map<string, number>()
  private readonly timer: ReturnType<typeof setInterval>
  private operation: Promise<void> = Promise.resolve()
  private deliveries: Promise<void> = Promise.resolve()
  private pendingBytes = 0
  private stopped = false

  constructor(private readonly options: DeviceSyncTcpOptions) {
    this.tcp = new FipsTcpEndpoint(options.endpoint, options.port, {
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
    void this.enqueue(async () => {
      if (connected) this.peers.add(peer)
      else {
        this.peers.delete(peer)
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
      if (this.connections.has(peer) || !shouldInitiate(this.options.localPeer, peer)) continue
      const id = await this.tcp.connect(peer)
      this.connections.set(peer, id)
      this.readers.set(id, new RecordReader(this.options.maxRecordBytes))
    }
  }

  private async progress(): Promise<void> {
    await this.acceptConnections()
    for (const [peer, id] of [...this.connections]) {
      if (await this.tcp.state(id) !== State.Established) continue
      if (!this.established.has(id)) {
        this.established.add(id)
        try {
          this.options.onConnected?.(peer)
        } catch (error) {
          this.report(error)
        }
      }
      await this.drainWrites(peer, id)
      await this.drainReads(peer, id)
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
      if (previous !== undefined && previous !== id) {
        await this.tcp.close(previous)
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
      const accepted = await this.tcp.write(id, write.bytes.subarray(write.offset))
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

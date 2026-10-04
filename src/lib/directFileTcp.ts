import {
  FipsTcpEndpoint, MarkerStatus, State,
  type Config, type ConnectionId, type FipsDatagramEndpoint, type SendMarker,
} from '@fips/tcp'
import { sha256 } from '@noble/hashes/sha2.js'

export const DIRECT_FILE_PORT = 39512
export const DIRECT_FILE_CHUNK_BYTES = 32 * 1024
const MAX_TRANSFERS = 16
const MAX_FILES = 32
const MAX_FILE_BYTES = 100 * 1024 * 1024 * 1024
const MEMORY_RECEIVE_BYTES = 64 * 1024 * 1024
const IDLE_MS = 60_000
const OFFER_MS = 24 * 60 * 60 * 1000
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export interface DirectFileSpec { filename: string; sizeBytes: number; sha256: string }
export interface DirectFileSource extends DirectFileSpec { blob: Blob }
export interface DirectFileResult { filename: string; blob?: Blob }
/** User-selected destinations may defer committing their temporary file until
 * every file has passed verification. abort must preserve pre-existing files. */
export interface DirectFileSink {
  write(chunk: Uint8Array): Promise<void>
  finish(): Promise<Blob | undefined>
  commit?(): Promise<Blob>
  abort(): Promise<void>
}
export interface DirectFileEvent {
  type: 'accepted' | 'progress' | 'completed' | 'declined' | 'cancelled' | 'failed'
  transferId: string
  peer: string
  transferredBytes?: number
  totalBytes?: number
  files?: DirectFileResult[]
  error?: string
}
export interface DirectFileTcpOptions {
  endpoint: FipsDatagramEndpoint
  localPeer: string
  onEvent: (event: DirectFileEvent) => void
  onError?: (error: Error) => void
  createReceiveFile?: (transferId: string, index: number, spec: DirectFileSpec) => Promise<DirectFileSink>
  tcpConfig?: Partial<Config>
  isnSeed?: bigint | number
}
type Control = { type: 'accept' | 'decline'; id: string; token: string } |
  { type: 'done' | 'received' | 'cancel' }
interface Offer { token: string; peers: Set<string>; files: DirectFileSource[]; expires: number }
interface Pending { bytes: Uint8Array; offset: number; marker?: SendMarker }
interface Sending { kind: 'sending'; files: DirectFileSource[]; index: number; offset: number; transferred: number; total: number }
interface Receiving {
  kind: 'receiving'; files: DirectFileSpec[]; index: number; offset: number
  transferred: number; total: number; hash: ReturnType<typeof sha256.create>
  sinks: DirectFileSink[]; results: DirectFileResult[]; reserved: number; committed: boolean
}
type Role = Sending | Receiving | { kind: 'request' | 'finish' | 'decline' }
interface Connection {
  transferId: string; peer: string; role: Role; reader: DirectFileReader
  pending?: Pending; doneSent: boolean; cancelled: boolean; revoked: boolean
  lastActivity: number; lastProgress: number; terminal: boolean
}

/** Native-compatible, recipient-pulled file streams over authenticated FIPS. */
export class DirectFileTcp {
  private readonly tcp: FipsTcpEndpoint
  private readonly localPeer: string
  private readonly offers = new Map<string, Offer>()
  private readonly connections = new Map<ConnectionId, Connection>()
  private readonly opening = new Set<string>()
  private readonly ended = new Set<string>()
  private readonly timer: ReturnType<typeof setInterval>
  private operation: Promise<unknown> = Promise.resolve()
  private tickPending = false
  private stopped = false
  private memoryReserved = 0

  constructor(private readonly options: DirectFileTcpOptions) {
    this.localPeer = normalizePeer(options.localPeer)
    // FIPS exposes compressed keys (whose parity may change after a handshake),
    // while offers identify devices by their stable x-only key. Keep TCP stream
    // keys stable and supply FIPS with the compressed key its route proofs need.
    const endpoint: FipsDatagramEndpoint = {
      registerService: (port, handler) => options.endpoint.registerService(port, context =>
        handler({ ...context, src: normalizePeer(context.src) })),
      sendDatagram: args => options.endpoint.sendDatagram({ ...args, dst: `02${normalizePeer(args.dst)}` }),
    }
    this.tcp = new FipsTcpEndpoint(endpoint, DIRECT_FILE_PORT, {
      mss: 1024, sendBuffer: 64 * 1024, receiveBuffer: 0xffff,
      maxConnections: MAX_TRANSFERS, maxConnectionsPerPeer: 4, maxReassemblySegments: 128,
      ...options.tcpConfig,
    }, options.isnSeed ?? randomSeed())
    this.timer = setInterval(() => {
      // Slow disk writes apply TCP backpressure, never a growing timer queue.
      if (this.tickPending || this.stopped) return
      this.tickPending = true
      void this.enqueue(() => this.tick()).catch(error => this.report(error))
        .finally(() => { this.tickPending = false })
    }, 10)
  }

  registerOffer(id: string, token: string, allowedPeers: string[], files: DirectFileSource[]): void {
    this.assertAvailable(id)
    validateClaim(id, token)
    validateFiles(files)
    if (this.offers.size >= MAX_TRANSFERS || allowedPeers.length > 128) throw new Error('Too many file transfers')
    const peers = new Set(allowedPeers.map(normalizePeer).filter(peer => peer !== this.localPeer))
    if (!peers.size) throw new Error('No receiving device is available')
    for (const file of files) {
      if (file.blob.size !== file.sizeBytes) throw new Error('Selected file changed')
    }
    this.offers.set(id, { token, peers, files: files.map(file => ({ ...file })), expires: Date.now() + OFFER_MS })
  }

  /** Restrictions only remove recipients; an owner's other devices stay distinct. */
  restrictOffer(id: string, allowedPeers: string[]): void {
    const peers = new Set(allowedPeers.map(normalizePeer))
    const offer = this.offers.get(id)
    if (offer) {
      for (const peer of offer.peers) if (!peers.has(peer)) offer.peers.delete(peer)
      if (!offer.peers.size) {
        this.offers.delete(id)
        this.rememberEnded(id)
        this.emit({ type: 'failed', transferId: id, peer: '', error: 'Receiving device authorization changed' })
      }
    }
    for (const c of this.connections.values()) {
      if (c.transferId === id && !peers.has(c.peer)) c.revoked = true
    }
  }

  async receive(id: string, token: string, senderPeer: string, files: DirectFileSpec[]): Promise<void> {
    this.assertAvailable(id)
    validateClaim(id, token)
    validateFiles(files)
    const peer = normalizePeer(senderPeer)
    if (peer === this.localPeer) throw new Error('Choose another device to receive these files')
    const total = files.reduce((sum, file) => sum + file.sizeBytes, 0)
    const reserved = this.options.createReceiveFile ? 0 : total
    if (reserved + this.memoryReserved > MEMORY_RECEIVE_BYTES) {
      throw new Error('This browser can receive up to 64 MB without local file storage')
    }
    this.memoryReserved += reserved
    this.opening.add(id)
    try {
      await this.enqueue(async () => {
        if (this.stopped || this.ended.has(id)) throw new Error('File transfer cancelled')
        const stream = await this.tcp.connect(peer)
        const role: Receiving = {
          kind: 'receiving', files: files.map(file => ({ ...file })), index: 0, offset: 0,
          transferred: 0, total, hash: sha256.create(), sinks: [], results: [], reserved, committed: false,
        }
        const c = newConnection(id, peer, role)
        c.cancelled = this.ended.has(id) || this.stopped
        c.pending = pendingControl({ type: 'accept', id, token })
        this.connections.set(stream, c)
      })
    } catch (error) {
      this.memoryReserved -= reserved
      if (!this.ended.has(id)) {
        this.rememberEnded(id)
        this.emit({ type: 'failed', transferId: id, peer, error: errorText(error) })
      }
      throw error
    } finally { this.opening.delete(id) }
  }

  async decline(id: string, token: string, senderPeer: string): Promise<void> {
    this.assertAvailable(id)
    validateClaim(id, token)
    const peer = normalizePeer(senderPeer)
    if (peer === this.localPeer) throw new Error('Choose another device to receive these files')
    this.opening.add(id)
    try {
      await this.enqueue(async () => {
        if (this.stopped || this.ended.has(id)) return
        const stream = await this.tcp.connect(peer)
        const c = newConnection(id, peer, { kind: 'decline' })
        c.pending = pendingControl({ type: 'decline', id, token })
        c.cancelled = this.ended.has(id) || this.stopped
        this.connections.set(stream, c)
      })
    } finally { this.opening.delete(id) }
  }

  cancel(id: string): void {
    if (this.ended.has(id) || [...this.connections.values()].some(c => c.transferId === id && c.terminal)) return
    this.offers.delete(id)
    const active = [...this.connections.values()].filter(c => c.transferId === id && !c.terminal)
    for (const c of active) c.cancelled = true
    this.rememberEnded(id)
    if (!active.length) this.emit({ type: 'cancelled', transferId: id, peer: '' })
  }

  async dispose(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    clearInterval(this.timer)
    await this.operation
    for (const [stream, c] of this.connections) {
      await this.fail(stream, c, new Error('File connection stopped'))
    }
    for (const id of this.offers.keys()) this.emit({ type: 'failed', transferId: id, peer: '', error: 'File connection stopped' })
    this.offers.clear()
    this.ended.clear()
    await this.tcp.dispose()
  }

  private assertAvailable(id: string): void {
    if (this.stopped) throw new Error('File connection stopped')
    if (this.offers.has(id) || this.opening.has(id) || this.ended.has(id) ||
      [...this.connections.values()].some(c => c.transferId === id)) throw new Error('File offer is already in use')
    if (this.connections.size + this.opening.size >= MAX_TRANSFERS) throw new Error('Too many file transfers')
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    for (const [id, offer] of this.offers) {
      if (Date.now() < offer.expires) continue
      this.offers.delete(id)
      this.rememberEnded(id)
      this.emit({ type: 'failed', transferId: id, peer: '', error: 'File offer expired' })
    }
    await this.tcp.poll()
    for (;;) {
      const stream = await this.tcp.accept()
      if (stream === undefined) break
      const remote = await this.tcp.peer(stream)
      let peer: string | undefined
      try { if (remote) peer = normalizePeer(remote) } catch { /* Reject non-identities. */ }
      if (!peer || peer === this.localPeer || this.connections.size >= MAX_TRANSFERS) {
        await this.tcp.abort(stream)
      } else this.connections.set(stream, newConnection('', peer, { kind: 'request' }))
    }
    for (const [stream, c] of [...this.connections]) {
      try {
        if (!await this.progress(stream, c)) {
          this.connections.delete(stream)
          this.rememberEnded(c.transferId)
          await this.cleanup(c)
          try { await this.tcp.close(stream) } catch { /* Peer may already have closed. */ }
        }
      } catch (error) { await this.fail(stream, c, error) }
    }
  }

  private async progress(stream: ConnectionId, c: Connection): Promise<boolean> {
    if (c.revoked) throw new Error('Device authorization changed')
    if (c.cancelled && !c.terminal) {
      await this.cleanup(c)
      c.role = { kind: 'finish' }
      c.doneSent = false
      c.terminal = true
      this.emit({ type: 'cancelled', transferId: c.transferId, peer: c.peer })
    }
    const state = await this.tcp.state(stream)
    if (!state) throw new Error('File connection closed')
    if (Date.now() - c.lastActivity > IDLE_MS) throw new Error('File transfer timed out')
    if (state === State.SynSent || state === State.SynReceived) return true
    if (state !== State.Established && state !== State.CloseWait) throw new Error('File connection closed')
    const bytes = await this.tcp.read(stream, DIRECT_FILE_CHUNK_BYTES + 1024)
    if (bytes.length) {
      c.lastActivity = Date.now()
      for (const packet of c.reader.push(bytes)) {
        if (!await this.handlePacket(c, packet)) return false
        if (c.cancelled || c.revoked) return true
      }
    }
    if (state === State.CloseWait && c.role.kind !== 'finish' && c.role.kind !== 'decline') {
      throw new Error('File connection closed before completion')
    }
    if (c.pending?.marker) {
      const status = await this.tcp.markerStatus(c.pending.marker)
      if (status === MarkerStatus.ConnectionGone) throw new Error('File connection closed')
      if (status === MarkerStatus.Acked && c.pending.offset === c.pending.bytes.length) {
        c.pending = undefined
        c.lastActivity = Date.now()
      }
    }
    if (!c.pending) {
      if (c.role.kind === 'sending') {
        const role = c.role
        const chunk = await nextChunk(role)
        if (c.cancelled || c.revoked) return true
        if (chunk) c.pending = pendingBytes(directFileFrame(1, chunk))
        else if (!c.doneSent) {
          c.pending = pendingControl({ type: 'done' })
          c.doneSent = true
        }
      } else if (c.role.kind === 'finish') {
        if (c.doneSent) return false
        c.pending = pendingControl({ type: 'cancel' })
        c.doneSent = true
      } else if (c.role.kind === 'decline') {
        c.terminal = true
        this.emit({ type: 'declined', transferId: c.transferId, peer: c.peer })
        return false
      }
    }
    if (c.pending && c.pending.offset < c.pending.bytes.length) {
      if (c.revoked || (c.cancelled && !c.terminal)) return true
      const result = await this.tcp.writeWithMarker(stream, c.pending.bytes.subarray(c.pending.offset))
      if (result.accepted) {
        c.pending.offset += result.accepted
        c.pending.marker = result.marker
        c.lastActivity = Date.now()
      }
    }
    if (Date.now() - c.lastProgress >= 250 && (c.role.kind === 'sending' || c.role.kind === 'receiving')) {
      c.lastProgress = Date.now()
      this.emit({ type: 'progress', transferId: c.transferId, peer: c.peer,
        transferredBytes: c.role.transferred, totalBytes: c.role.total })
    }
    return true
  }

  private async handlePacket(c: Connection, packet: Uint8Array): Promise<boolean> {
    if (packet[0] === 1) {
      if (c.role.kind === 'finish') return true
      if (c.role.kind !== 'receiving') throw new Error('Unexpected file data')
      if (packet.length === 1) throw new Error('Empty file data frame')
      await this.writeReceived(c, c.role, packet.subarray(1))
      return true
    }
    const control = parseControl(packet)
    if (c.role.kind === 'finish') return control.type !== 'cancel'
    if ((control.type === 'accept' || control.type === 'decline') && c.role.kind === 'request') {
      validateClaim(control.id, control.token)
      const offer = this.offers.get(control.id)
      if (!offer || offer.expires <= Date.now() || offer.token !== control.token || !offer.peers.has(c.peer)) {
        throw new Error('File offer is not available to this device')
      }
      // Claim synchronously before any await: exactly one device may read bytes.
      this.offers.delete(control.id)
      c.transferId = control.id
      if (control.type === 'decline') {
        c.terminal = true
        this.emit({ type: 'declined', transferId: c.transferId, peer: c.peer })
        return false
      }
      c.role = { kind: 'sending', files: offer.files, index: 0, offset: 0, transferred: 0,
        total: offer.files.reduce((sum, file) => sum + file.sizeBytes, 0) }
      this.emit({ type: 'accepted', transferId: c.transferId, peer: c.peer })
      return true
    }
    if (control.type === 'done' && c.role.kind === 'receiving') {
      const role = c.role
      await this.advanceReceived(c, role)
      if (c.cancelled || c.revoked) return true
      if (role.index !== role.files.length) throw new Error('File transfer ended before all files arrived')
      for (const [index, sink] of role.sinks.entries()) {
        if (c.cancelled || c.revoked || this.stopped) return true
        if (sink.commit) role.results[index].blob = await sink.commit()
        if (role.results[index].blob?.size !== role.files[index].sizeBytes) throw new Error('Received file was not saved completely')
      }
      if (c.cancelled || c.revoked || this.stopped) return true
      role.committed = true
      await this.cleanup(c)
      c.role = { kind: 'finish' }
      c.pending = pendingControl({ type: 'received' })
      c.doneSent = true
      c.terminal = true
      this.emit({ type: 'completed', transferId: c.transferId, peer: c.peer, files: role.results,
        transferredBytes: role.transferred, totalBytes: role.total })
      return true
    }
    if (control.type === 'received' && c.role.kind === 'sending' && c.doneSent) {
      c.terminal = true
      this.emit({ type: 'completed', transferId: c.transferId, peer: c.peer, files: [],
        transferredBytes: c.role.transferred, totalBytes: c.role.total })
      return false
    }
    if (control.type === 'cancel' && c.role.kind !== 'request') {
      await this.cleanup(c)
      c.terminal = true
      this.emit({ type: 'cancelled', transferId: c.transferId, peer: c.peer })
      return false
    }
    throw new Error('Invalid file transfer request')
  }

  private async advanceReceived(c: Connection, role: Receiving): Promise<void> {
    while (role.index < role.files.length) {
      if (c.cancelled || c.revoked || this.stopped) return
      const file = role.files[role.index]
      if (!role.sinks[role.index]) {
        const sink = this.options.createReceiveFile
          ? await this.options.createReceiveFile(c.transferId, role.index, file)
          : new MemorySink()
        role.sinks.push(sink)
      }
      if (role.offset !== file.sizeBytes) return
      if (toHex(role.hash.digest()) !== file.sha256.toLowerCase()) throw new Error('Received file did not match the offer')
      const blob = await role.sinks[role.index].finish()
      if (blob ? blob.size !== file.sizeBytes : !role.sinks[role.index].commit) throw new Error('Received file was not saved completely')
      role.results.push({ filename: file.filename, blob })
      role.index += 1
      role.offset = 0
      role.hash = sha256.create()
    }
  }

  private async writeReceived(c: Connection, role: Receiving, data: Uint8Array): Promise<void> {
    await this.advanceReceived(c, role)
    while (data.length) {
      if (c.cancelled || c.revoked || this.stopped) return
      const file = role.files[role.index]
      if (!file) throw new Error('Received more data than offered')
      const count = Math.min(data.length, file.sizeBytes - role.offset)
      const chunk = data.subarray(0, count)
      await role.sinks[role.index].write(chunk)
      role.hash.update(chunk)
      role.offset += count
      role.transferred += count
      data = data.subarray(count)
      await this.advanceReceived(c, role)
    }
  }

  private async cleanup(c: Connection): Promise<void> {
    if (c.role.kind !== 'receiving') return
    const role = c.role
    this.memoryReserved -= role.reserved
    role.reserved = 0
    if (!role.committed) {
      await Promise.allSettled(role.sinks.map(sink => sink.abort()))
      role.sinks = []
      role.results = []
      role.hash.destroy()
    }
  }

  private async fail(stream: ConnectionId, c: Connection, error: unknown): Promise<void> {
    this.connections.delete(stream)
    await this.cleanup(c)
    this.rememberEnded(c.transferId)
    if (c.transferId && !c.terminal) {
      c.terminal = true
      this.emit({ type: 'failed', transferId: c.transferId, peer: c.peer, error: errorText(error) })
    }
    try { await this.tcp.abort(stream) } catch { /* Already closed or disconnected. */ }
  }

  private rememberEnded(id: string): void {
    if (!id) return
    this.ended.add(id)
    if (this.ended.size > 256) this.ended.delete(this.ended.values().next().value as string)
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operation.then(work, work)
    this.operation = result.catch(() => undefined)
    return result
  }
  private emit(event: DirectFileEvent): void {
    try { this.options.onEvent(event) } catch (error) { this.report(error) }
  }
  private report(error: unknown): void {
    this.options.onError?.(error instanceof Error ? error : new Error(errorText(error)))
  }
}

class MemorySink implements DirectFileSink {
  private parts: BlobPart[] = []
  async write(chunk: Uint8Array): Promise<void> { this.parts.push(chunk.slice().buffer) }
  async finish(): Promise<Blob> { const blob = new Blob(this.parts); this.parts = []; return blob }
  async abort(): Promise<void> { this.parts = [] }
}
function newConnection(transferId: string, peer: string, role: Role): Connection {
  return { transferId, peer, role, reader: new DirectFileReader(), doneSent: false,
    cancelled: false, revoked: false, terminal: false, lastActivity: Date.now(), lastProgress: Date.now() }
}
async function nextChunk(role: Sending): Promise<Uint8Array | undefined> {
  while (role.index < role.files.length) {
    const file = role.files[role.index]
    if (role.offset === file.sizeBytes) { role.index += 1; role.offset = 0; continue }
    const length = Math.min(DIRECT_FILE_CHUNK_BYTES, file.sizeBytes - role.offset)
    const data = new Uint8Array(await file.blob.slice(role.offset, role.offset + length).arrayBuffer())
    if (data.length !== length) throw new Error('Selected file changed')
    role.offset += length
    role.transferred += length
    return data
  }
  return undefined
}
function validateClaim(id: string, token: string): void {
  if (!/^[a-z\d_-]{1,128}$/i.test(id) || !/^[a-f\d]{64}$/i.test(token)) throw new Error('Invalid file offer')
}
function validateFiles(files: DirectFileSpec[]): void {
  if (!files.length || files.length > MAX_FILES) throw new Error('Choose between 1 and 32 files')
  for (const file of files) {
    if (!file.filename || encoder.encode(file.filename).length > 240 || file.filename === '.' || file.filename === '..' ||
      /[\p{Cc}/\\<>:"|?*]/u.test(file.filename) || !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 || file.sizeBytes > MAX_FILE_BYTES || !/^[a-f\d]{64}$/i.test(file.sha256)) {
      throw new Error('Invalid file details')
    }
  }
}
function normalizePeer(peer: string): string {
  const normalized = /^(02|03)[a-f\d]{64}$/i.test(peer) ? peer.slice(2) : peer
  if (!/^[a-f\d]{64}$/i.test(normalized)) throw new Error('Invalid receiving device')
  return normalized.toLowerCase()
}
function randomSeed(): bigint {
  const bytes = crypto.getRandomValues(new Uint32Array(2))
  return (BigInt(bytes[0]) << 32n) | BigInt(bytes[1])
}
function toHex(data: Uint8Array): string { return Array.from(data, byte => byte.toString(16).padStart(2, '0')).join('') }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function pendingBytes(bytes: Uint8Array): Pending { return { bytes, offset: 0 } }
function pendingControl(control: Control): Pending { return pendingBytes(directFileFrame(0, encoder.encode(JSON.stringify(control)))) }

/** Exact native framing: u32-BE payload length, then kind byte and payload. */
export function directFileFrame(kind: 0 | 1, payload: Uint8Array): Uint8Array {
  if (payload.length > DIRECT_FILE_CHUNK_BYTES) throw new Error('File frame is too large')
  const framed = new Uint8Array(payload.length + 5)
  new DataView(framed.buffer).setUint32(0, payload.length + 1, false)
  framed[4] = kind
  framed.set(payload, 5)
  return framed
}
export class DirectFileReader {
  private bytes = new Uint8Array(0)
  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.length > DIRECT_FILE_CHUNK_BYTES + 1024) throw new Error('File read is too large')
    const combined = new Uint8Array(this.bytes.length + chunk.length)
    combined.set(this.bytes); combined.set(chunk, this.bytes.length)
    this.bytes = combined
    const packets: Uint8Array[] = []
    let consumed = 0
    while (this.bytes.length - consumed >= 4) {
      const length = new DataView(this.bytes.buffer, this.bytes.byteOffset + consumed, 4).getUint32(0, false)
      if (!length || length > DIRECT_FILE_CHUNK_BYTES + 1) throw new Error('Invalid file transfer frame size')
      const end = consumed + 4 + length
      if (end > this.bytes.length) break
      packets.push(this.bytes.slice(consumed + 4, end)); consumed = end
    }
    this.bytes = this.bytes.slice(consumed)
    return packets
  }
}
function parseControl(packet: Uint8Array): Control {
  if (packet[0] !== 0 || packet.length > 1024) throw new Error('Invalid file transfer frame')
  const value = JSON.parse(decoder.decode(packet.subarray(1))) as Record<string, unknown>
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid file transfer frame')
  const keys = Object.keys(value).sort().join(',')
  if ((value.type === 'accept' || value.type === 'decline') && keys === 'id,token,type' &&
    typeof value.id === 'string' && typeof value.token === 'string') return value as Control
  if ((value.type === 'done' || value.type === 'received' || value.type === 'cancel') && keys === 'type') return value as Control
  throw new Error('Invalid file transfer request')
}

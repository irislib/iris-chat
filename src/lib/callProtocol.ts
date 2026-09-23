/** Version 1 call payloads carried inside authenticated, encrypted FIPS datagrams. */
export const CALL_PORT = 39511
export const CALL_CODEC = 'pcm16-jpeg-v1'
export const MAX_VIDEO_BYTES = 65536
const HEADER = 29
const CHUNK = 1100
export type CallControl = {
  v: 1
  type: 'offer' | 'answer' | 'reject' | 'end' | 'ping' | 'pong' | 'media_state'
  call_id: string
  video?: boolean
  muted?: boolean
  reason?: string
  codec?: typeof CALL_CODEC
}
const types = new Set(['offer', 'answer', 'reject', 'end', 'ping', 'pong', 'media_state'])
export const validCallId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)
export function parseCallControl(bytes: Uint8Array): CallControl | null {
  if (!bytes.length || bytes.length > 2048) return null
  try {
    const p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (p.v !== 1 || !types.has(p.type) || !validCallId(p.call_id)) return null
    if (p.video !== undefined && typeof p.video !== 'boolean') return null
    if (p.muted !== undefined && typeof p.muted !== 'boolean') return null
    if (p.reason !== undefined && (typeof p.reason !== 'string' || p.reason.length > 120)) return null
    if (p.codec !== undefined && p.codec !== CALL_CODEC) return null
    return p
  } catch { return null }
}
export function encodeCallControl(packet: CallControl): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(packet))
}
export function encodeCallMedia(id: string, kind: 1 | 2, seq: number, bytes: Uint8Array): Uint8Array[] {
  if (!validCallId(id) || (kind === 1 ? bytes.length !== 640 : !bytes.length || bytes.length > MAX_VIDEO_BYTES)) return []
  const count = Math.ceil(bytes.length / CHUNK)
  return Array.from({ length: count }, (_, index) => {
    const body = bytes.subarray(index * CHUNK, (index + 1) * CHUNK)
    const packet = new Uint8Array(HEADER + body.length)
    packet.set([73, 67, 48, 49])
    packet.set(id.match(/../g)!.map(x => parseInt(x, 16)), 4)
    packet[20] = kind
    const view = new DataView(packet.buffer)
    view.setUint32(21, seq)
    view.setUint16(25, index)
    view.setUint16(27, count)
    packet.set(body, HEADER)
    return packet
  })
}
export function validJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
}
export interface MediaFrame { kind: 1 | 2; bytes: Uint8Array }
export class CallMediaReceiver {
  private partial = new Map<string, { created: number; kind: 1 | 2; seq: number; count: number; bytes: number; chunks: Map<number, Uint8Array> }>()
  private latest = new Map<number, number>()
  receive(id: string, packet: Uint8Array, now = performance.now()): MediaFrame | null {
    for (const [key, frame] of this.partial) if (now - frame.created > 500) this.partial.delete(key)
    if (packet.length <= HEADER || packet.length > HEADER + CHUNK || packet[0] !== 73 || packet[1] !== 67 || packet[2] !== 48 || packet[3] !== 49) return null
    const packetId = Array.from(packet.subarray(4, 20), b => b.toString(16).padStart(2, '0')).join('')
    if (packetId !== id) return null
    const kind = packet[20]
    if (kind !== 1 && kind !== 2) return null
    const v = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
    const seq = v.getUint32(21), index = v.getUint16(25), count = v.getUint16(27)
    if (!count || count > Math.ceil(MAX_VIDEO_BYTES / CHUNK) || index >= count || (kind === 1 && (count !== 1 || packet.length !== HEADER + 640))) return null
    const latest = this.latest.get(kind)
    if (latest !== undefined && ((seq - latest) >>> 0) > 0x7fffffff) return null
    if (seq === latest) return null
    const key = `${kind}:${seq}`
    let frame = this.partial.get(key)
    if (!frame) {
      if (this.partial.size >= 8) this.partial.delete(this.partial.keys().next().value!)
      frame = { created: now, kind, seq, count, bytes: 0, chunks: new Map() }
      this.partial.set(key, frame)
    }
    if (frame.count !== count || frame.chunks.has(index)) return null
    const chunk = packet.slice(HEADER)
    frame.bytes += chunk.length
    if (frame.bytes > MAX_VIDEO_BYTES) { this.partial.delete(key); return null }
    frame.chunks.set(index, chunk)
    if (frame.chunks.size !== count) return null
    const bytes = new Uint8Array(frame.bytes)
    let offset = 0
    for (let i = 0; i < count; i++) { const part = frame.chunks.get(i)!; bytes.set(part, offset); offset += part.length }
    this.partial.delete(key)
    if (kind === 2 && !validJpeg(bytes)) return null
    this.latest.set(kind, seq)
    return { kind, bytes }
  }
}

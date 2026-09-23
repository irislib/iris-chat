/** Signaling and compressed media travel only in authenticated FIPS datagrams. */
export const CALL_PORT = 39511
export const CALL_CODEC = 'opus-h264-v3'
export const MAX_AUDIO_BYTES = 1275
export const MAX_VIDEO_BYTES = 262144
const HEADER = 38
const CHUNK = 1100
export type CallControl = {
  v: 3
  type: 'offer' | 'answer' | 'reject' | 'end' | 'ping' | 'pong' | 'media_state' | 'feedback' | 'keyframe' | 'nack'
  call_id: string
  video?: boolean
  muted?: boolean
  reason?: string
  codec?: typeof CALL_CODEC
  frame_seq?: number
  missing?: number[]
  feedback_seq?: number
  video_seq?: number
  received_frames?: number
  received_bytes?: number
  interval_ms?: number
}
const types = new Set(['offer', 'answer', 'reject', 'end', 'ping', 'pong', 'media_state', 'feedback', 'keyframe', 'nack'])
export const validCallId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)
const validSequence = (seq: unknown): seq is number => typeof seq === 'number' && Number.isInteger(seq) && seq >= 0 && seq <= 0xffffffff
export function parseCallControl(bytes: Uint8Array): CallControl | null {
  if (!bytes.length || bytes.length > 2048) return null
  try {
    const p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (p.v !== 3 || !types.has(p.type) || !validCallId(p.call_id)) return null
    if (p.video !== undefined && typeof p.video !== 'boolean') return null
    if (p.muted !== undefined && typeof p.muted !== 'boolean') return null
    if (p.reason !== undefined && (typeof p.reason !== 'string' || p.reason.length > 120)) return null
    if (p.codec !== undefined && p.codec !== CALL_CODEC) return null
    if (p.type === 'feedback' && (![p.feedback_seq, p.received_frames, p.received_bytes, p.interval_ms].every(validSequence) || (p.video_seq !== undefined && !validSequence(p.video_seq)) || p.interval_ms < 200 || p.interval_ms > 5000)) return null
    if (p.type === 'nack' && (!validSequence(p.frame_seq) || !Array.isArray(p.missing) || !p.missing.length || p.missing.length > 64 || p.missing.some((n: unknown) => !validSequence(n) || n > 65535))) return null
    return p
  } catch { return null }
}
export function encodeCallControl(packet: CallControl): Uint8Array { return new TextEncoder().encode(JSON.stringify(packet)) }
export interface MediaFrame { kind: 1 | 2; seq: number; timestamp: number; key: boolean; bytes: Uint8Array }
export function encodeCallMedia(id: string, frame: MediaFrame): Uint8Array[] {
  const { kind, seq, timestamp, key, bytes } = frame
  if (!validCallId(id) || !validSequence(seq) || !Number.isSafeInteger(timestamp) || timestamp < 0 || !bytes.length || bytes.length > (kind === 1 ? MAX_AUDIO_BYTES : MAX_VIDEO_BYTES) || (kind !== 1 && kind !== 2)) return []
  const count = Math.ceil(bytes.length / CHUNK)
  return Array.from({ length: count }, (_, index) => {
    const body = bytes.subarray(index * CHUNK, (index + 1) * CHUNK)
    const packet = new Uint8Array(HEADER + body.length)
    packet.set([73, 67, 48, 51])
    packet.set(id.match(/../g)!.map(x => parseInt(x, 16)), 4)
    packet[20] = kind
    packet[21] = key ? 1 : 0
    const view = new DataView(packet.buffer)
    view.setUint32(22, seq)
    view.setBigUint64(26, BigInt(timestamp))
    view.setUint16(34, index)
    view.setUint16(36, count)
    packet.set(body, HEADER)
    return packet
  })
}
export class CallMediaReceiver {
  highestVideo?: number
  private partial = new Map<string, { created: number; requested: number; requests: number; frame: Omit<MediaFrame, 'bytes'>; count: number; bytes: number; chunks: Map<number, Uint8Array> }>()
  private completed = new Map<string, number>()
  missing(now = performance.now()): Array<{ frame_seq: number; missing: number[] }> {
    const requests: Array<{ frame_seq: number; missing: number[] }> = []
    for (const frame of this.partial.values()) {
      if (frame.frame.kind !== 2 || now - frame.created < 40 || now - frame.created > 250 || frame.requests >= 2 || (frame.requests && now - frame.requested < 50)) continue
      const missing = Array.from({ length: frame.count }, (_, i) => i).filter(i => !frame.chunks.has(i)).slice(0, 64)
      if (missing.length) { requests.push({ frame_seq: frame.frame.seq, missing }); frame.requested = now; frame.requests++ }
      if (requests.length === 2) break
    }
    return requests
  }
  receive(id: string, packet: Uint8Array, now = performance.now()): MediaFrame | null {
    for (const [key, frame] of this.partial) if (now - frame.created > 250) this.partial.delete(key)
    for (const [key, received] of this.completed) if (now - received > 10000) this.completed.delete(key)
    if (packet.length <= HEADER || packet.length > HEADER + CHUNK || packet[0] !== 73 || packet[1] !== 67 || packet[2] !== 48 || packet[3] !== 51) return null
    if (Array.from(packet.subarray(4, 20), b => b.toString(16).padStart(2, '0')).join('') !== id) return null
    const kind = packet[20]
    if ((kind !== 1 && kind !== 2) || packet[21] > 1) return null
    const v = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
    const seq = v.getUint32(22), timestamp = Number(v.getBigUint64(26)), index = v.getUint16(34), count = v.getUint16(36), keyFrame = !!packet[21]
    const max = kind === 1 ? MAX_AUDIO_BYTES : MAX_VIDEO_BYTES
    if (!Number.isSafeInteger(timestamp) || !count || count > Math.ceil(max / CHUNK) || index >= count || (index < count - 1 && packet.length !== HEADER + CHUNK)) return null
    if (kind === 2 && (this.highestVideo === undefined || ((seq - this.highestVideo) >>> 0) < 0x80000000)) this.highestVideo = seq
    const key = `${kind}:${seq}`
    if (this.completed.has(key)) return null
    let frame = this.partial.get(key)
    if (!frame) {
      if (this.partial.size >= 16) this.partial.delete(this.partial.keys().next().value!)
      frame = { created: now, requested: 0, requests: 0, frame: { kind, seq, timestamp, key: keyFrame }, count, bytes: 0, chunks: new Map() }
      this.partial.set(key, frame)
    }
    if (frame.count !== count || frame.frame.timestamp !== timestamp || frame.frame.key !== keyFrame || frame.chunks.has(index)) return null
    const chunk = packet.slice(HEADER)
    frame.bytes += chunk.length
    if (frame.bytes > max) { this.partial.delete(key); return null }
    frame.chunks.set(index, chunk)
    if (frame.chunks.size !== count) return null
    const bytes = new Uint8Array(frame.bytes)
    let offset = 0
    for (let i = 0; i < count; i++) { const part = frame.chunks.get(i)!; bytes.set(part, offset); offset += part.length }
    this.partial.delete(key)
    this.completed.set(key, now)
    while (this.completed.size > 128) this.completed.delete(this.completed.keys().next().value!)
    return { ...frame.frame, bytes }
  }
}

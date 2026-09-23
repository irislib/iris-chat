import { writable, get } from 'svelte/store'
import type { CallOutcome } from './callHistory'
import type { CallSettings } from './callSettings'
import { CALL_CODEC, CALL_PORT, CallMediaReceiver, encodeCallControl, encodeCallMedia, parseCallControl, type CallControl, type MediaFrame } from './callProtocol'
export interface CallState {
  id: string; owner: string; peer?: string; peers: string[]; direction: 'incoming' | 'outgoing'
  status: 'ringing' | 'connecting' | 'active' | 'ended'; video: boolean; muted: boolean
  camera: boolean; remoteMuted: boolean; remoteVideo: boolean; started: number; connected?: number; endedAt?: number; outcome?: CallOutcome; reason?: string
  receivedAudio: number; receivedVideo: number
}
export interface CallEndpoint {
  sendDatagram(args: { dst: string; srcPort: number; dstPort: number; payload: Uint8Array }): Promise<void>
  registerService(port: number, handler: (ctx: { src: string; payload: Uint8Array }) => void): () => void
}
// FIPS addresses identify the full x-only key; Noise may reveal its actual parity.
function canonicalCallPeer(peer: string) {
  return /^(02|03)[0-9a-f]{64}$/.test(peer) ? `02${peer.slice(2)}` : peer
}
export class CallSession {
  readonly state = writable<CallState | null>(null)
  onMedia?: (frame: MediaFrame) => void
  onFeedback?: (feedback: CallControl) => void
  onKeyframe?: () => void
  onEnded?: () => void
  private receiver = new CallMediaReceiver()
  private ended = new Map<string, number>()
  private dispositions = new Map<string, { owner: string; peers: string[]; packet: CallControl }>()
  private lastHeard = 0
  private mediaReady = false
  private retransmitCache = new Map<number, { at: number; packets: Uint8Array[]; bytes: number }>()
  private retransmitWindow = 0
  private retransmitCount = 0
  private recoveryTimer: ReturnType<typeof setInterval>
  private unregister: () => void
  private timer: ReturnType<typeof setInterval>
  constructor(
    private endpoint: CallEndpoint,
    private ownerForPeer: (peer: string) => string | undefined,
    private settings: () => Pick<CallSettings, 'voice' | 'video'> = () => ({ voice: true, video: true }),
    private hasCallHistory: (owner: string, id: string) => boolean = () => false,
  ) {
    this.unregister = endpoint.registerService(CALL_PORT, ({ src, payload }) => { this.receive(src, payload) })
    this.timer = setInterval(() => this.tick(), 1000)
    this.recoveryTimer = setInterval(() => {
      if (get(this.state)?.status === 'active') for (const missing of this.receiver.missing()) this.broadcast('nack', missing)
    }, 50)
  }
  private rememberEnded(id: string) {
    this.ended.set(id, Date.now())
    while (this.ended.size > 128) this.ended.delete(this.ended.keys().next().value!)
  }
  private send(peer: string, packet: CallControl) {
    void this.endpoint.sendDatagram({ dst: peer, srcPort: CALL_PORT, dstPort: CALL_PORT, payload: encodeCallControl(packet) }).catch(() => {})
  }
  private rememberDisposition(s: CallState, peers: string[], packet: CallControl) {
    this.dispositions.set(s.id, { owner: s.owner, peers, packet })
    while (this.dispositions.size > 128) this.dispositions.delete(this.dispositions.keys().next().value!)
  }
  private broadcast(type: CallControl['type'], extra: Partial<CallControl> = {}) {
    const s = get(this.state)
    if (!s) return
    for (const peer of s.peer ? [s.peer] : s.peers) this.send(peer, { v: 3, type, call_id: s.id, video: s.camera, muted: s.muted, ...extra })
  }
  start(owner: string, peers: string[], video: boolean) {
    if (get(this.state)?.status !== 'ended' && get(this.state)) throw new Error('A call is already open')
    peers = [...new Set(peers.map(canonicalCallPeer))]
    if (!peers.length || peers.some(p => this.ownerForPeer(p) !== owner)) throw new Error('This person is not connected. Try again when they are nearby or online.')
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')
    this.resetMedia()
    this.state.set({ id, owner, peers, direction: 'outgoing', status: 'ringing', video, muted: false, camera: video, remoteMuted: false, remoteVideo: video, started: Date.now(), receivedAudio: 0, receivedVideo: 0 })
    this.broadcast('offer', { video, codec: CALL_CODEC })
  }
  accept(video = false) {
    const s = get(this.state)
    if (!s || s.status !== 'ringing' || s.direction !== 'incoming') return
    this.lastHeard = Date.now()
    const withVideo = s.video && video && this.settings().video
    if (!withVideo && !this.settings().voice) return
    this.state.set({ ...s, status: 'active', connected: this.mediaReady ? Date.now() : undefined, video: withVideo, camera: s.camera && withVideo, remoteVideo: withVideo })
    this.broadcast('answer', { video: withVideo, codec: CALL_CODEC })
  }
  markMediaReady() {
    this.mediaReady = true
    this.state.update(s => s?.status === 'active' && s.connected === undefined ? { ...s, connected: Date.now() } : s)
  }
  end(reason = 'Call ended', notify = true, outcome?: CallOutcome) {
    const s = get(this.state)
    if (!s || s.status === 'ended') return
    const declined = outcome === 'declined'
    const packet: CallControl = { v: 3, type: s.direction === 'incoming' && s.status === 'ringing' ? 'reject' : 'end', call_id: s.id,
      reason: declined ? 'declined' : undefined }
    const targets = s.peer ? [s.peer] : s.peers
    if (notify && declined) this.rememberDisposition(s, targets, packet)
    this.rememberEnded(s.id)
    const elsewhere = outcome === 'answered_elsewhere'
    this.state.set({ ...s, status: 'ended', reason, endedAt: Date.now(),
      connected: elsewhere || declined ? undefined : s.connected,
      outcome: elsewhere ? 'answered_elsewhere' : declined ? 'declined' : s.connected !== undefined ? 'answered' : outcome ?? (s.direction === 'incoming' ? 'missed' : 'canceled'),
    })
    this.onEnded?.()
    if (notify) for (const peer of targets) this.send(peer, packet)
  }
  clear() { if (get(this.state)?.status === 'ended') this.state.set(null) }
  setMedia(muted: boolean, camera: boolean) {
    if (!camera) this.retransmitCache.clear()
    this.state.update(s => s ? { ...s, muted, camera: s.video && camera } : s)
    this.broadcast('media_state', { muted, video: camera })
  }
  private resetMedia() { this.mediaReady = false; this.receiver = new CallMediaReceiver(); this.retransmitCache.clear() }
  sendFeedback(feedback: Pick<CallControl, 'feedback_seq' | 'video_seq' | 'received_frames' | 'received_bytes' | 'interval_ms'>) {
    if (get(this.state)?.status === 'active') this.broadcast('feedback', feedback)
  }
  get highestVideo() { return this.receiver.highestVideo }
  requestKeyframe() { if (get(this.state)?.status === 'active') this.broadcast('keyframe') }
  async sendMedia(frame: MediaFrame) {
    const s = get(this.state)
    if (!s?.peer || s.status !== 'active' || (frame.kind === 1 && s.muted) || (frame.kind === 2 && (!s.video || !s.camera))) return
    const began = performance.now()
    const packets = encodeCallMedia(s.id, frame)
    if (frame.kind === 2) {
      for (const [seq, cached] of this.retransmitCache) if (began - cached.at > 300) this.retransmitCache.delete(seq)
      this.retransmitCache.set(frame.seq, { at: began, packets, bytes: packets.reduce((n, p) => n + p.length, 0) })
      while (this.retransmitCache.size > 8 || [...this.retransmitCache.values()].reduce((n, entry) => n + entry.bytes, 0) > 1048576) this.retransmitCache.delete(this.retransmitCache.keys().next().value!)
    }
    for (const payload of packets) {
      const current = get(this.state)
      if (!current || current.status !== 'active' || (frame.kind === 1 && current.muted) || (frame.kind === 2 && (!current.video || !current.camera)) || current.id !== s.id || current.peer !== s.peer || this.ownerForPeer(s.peer) !== s.owner || performance.now() - began > 150) return
      await this.endpoint.sendDatagram({ dst: s.peer, srcPort: CALL_PORT, dstPort: CALL_PORT, payload })
    }
  }
  updateStats(receivedAudio: number, receivedVideo: number) {
    this.state.update(s => s && s.status === 'active' ? { ...s, receivedAudio, receivedVideo: s.video ? receivedVideo : 0 } : s)
  }
  private receive(peer: string, payload: Uint8Array) {
    peer = canonicalCallPeer(peer)
    const owner = this.ownerForPeer(peer)
    if (!owner) return
    let s = get(this.state)
    const p = parseCallControl(payload)
    if (!p) {
      if (!s || s.status !== 'active' || s.peer !== peer || s.owner !== owner) return
      const frame = this.receiver.receive(s.id, payload)
      if (!frame) return
      if (frame.kind === 1 || s.video) this.onMedia?.(frame)
      return
    }
    const disposition = this.dispositions.get(p.call_id)
    if (disposition?.owner === owner && disposition.peers.includes(peer) && ['offer', 'answer', 'ping'].includes(p.type)) {
      this.send(peer, disposition.packet)
      return
    }
    if (this.ended.has(p.call_id)) {
      if (p.type === 'ping' || p.type === 'offer') this.send(peer, { v: 3, type: 'end', call_id: p.call_id })
      return
    }
    // Datagram order is not guaranteed: a cancelled offer must not ring later.
    if (p.type === 'end' && (!s || s.id !== p.call_id)) {
      this.rememberEnded(p.call_id)
      return
    }
    if (p.type === 'offer') {
      // Persisted history outlives the in-memory tombstones. A duplicate of the
      // current call still needs its normal answer/retransmission handling.
      if ((!s || s.id !== p.call_id || s.owner !== owner) && this.hasCallHistory(owner, p.call_id)) {
        this.rememberEnded(p.call_id)
        this.send(peer, { v: 3, type: 'end', call_id: p.call_id })
        return
      }
      const settings = this.settings()
      if (p.video ? !settings.video && !settings.voice : !settings.voice) {
        this.rememberEnded(p.call_id)
        this.send(peer, { v: 3, type: 'reject', call_id: p.call_id }); return
      }
      if (s && s.status === 'ringing' && s.direction === 'outgoing' && s.owner === owner && p.call_id < s.id) {
        this.end('Call ended')
        s = get(this.state)
      }
      if (s && s.status !== 'ended') {
        if (s.id === p.call_id && s.peer === peer) this.lastHeard = Date.now()
        if (s.id === p.call_id && s.peer === peer && s.status === 'active') this.broadcast('answer', { video: s.video, codec: CALL_CODEC })
        else if (s.id !== p.call_id) {
          this.rememberEnded(p.call_id)
          this.send(peer, { v: 3, type: 'reject', call_id: p.call_id, reason: 'busy' })
        }
        return
      }
      this.resetMedia()
      this.lastHeard = Date.now()
      this.state.set({ id: p.call_id, owner, peer, peers: [peer], direction: 'incoming', status: 'ringing', video: !!p.video, muted: false, camera: !!p.video, remoteMuted: false, remoteVideo: !!p.video, started: Date.now(), receivedAudio: 0, receivedVideo: 0 })
      return
    }
    if (!s || s.id !== p.call_id || s.owner !== owner || !s.peers.includes(peer)) return
    if (s.peer && s.peer !== peer) {
      if (s.direction === 'outgoing' && s.status === 'active' && (p.type === 'answer' || p.type === 'ping')) {
        this.send(peer, { v: 3, type: 'end', call_id: s.id, reason: 'answered_elsewhere', video: s.video })
      }
      return
    }
    this.lastHeard = Date.now()
    if (p.type === 'answer' && s.direction === 'outgoing' && s.status === 'ringing') {
      const others = s.peers.filter(other => other !== peer)
      const packet: CallControl = { v: 3, type: 'end', call_id: s.id, reason: 'answered_elsewhere', video: s.video && !!p.video }
      this.rememberDisposition(s, others, packet)
      this.state.set({ ...s, status: 'active', connected: this.mediaReady ? Date.now() : undefined, peer, video: s.video && !!p.video, camera: s.camera && !!p.video, remoteVideo: s.video && !!p.video })
      for (const other of others) this.send(other, packet)
    } else if (p.type === 'nack' && s.status === 'active' && s.video) {
      void this.retransmit(s, p)
    } else if (p.type === 'feedback' && s.status === 'active' && s.video) {
      this.onFeedback?.(p)
    } else if (p.type === 'keyframe' && s.status === 'active' && s.video) {
      this.onKeyframe?.()
    } else if (p.type === 'end' && p.reason === 'answered_elsewhere' && s.direction === 'incoming') {
      this.state.set({ ...s, video: s.video && (p.video ?? s.video) })
      this.end('Answered on another device', false, 'answered_elsewhere')
    } else if (p.type === 'reject' || p.type === 'end') {
      if (p.reason === 'declined') this.end('Call declined', s.direction === 'outgoing', 'declined')
      else if (!s.peer && p.type === 'reject' && s.peers.length > 1) this.state.set({ ...s, peers: s.peers.filter(x => x !== peer) })
      else this.end(p.type === 'reject' ? (p.reason === 'busy' ? 'Busy' : 'Call declined') : 'Call ended', false, p.type === 'reject' ? 'declined' : undefined)
    } else if (p.type === 'ping' || p.type === 'pong' || p.type === 'media_state') {
      this.state.set({ ...s, remoteMuted: p.muted ?? s.remoteMuted, remoteVideo: s.video && (p.video ?? s.remoteVideo) })
      if (p.type === 'ping') this.broadcast('pong')
    }
  }
  private async retransmit(s: CallState, control: CallControl) {
    const now = performance.now(), cached = this.retransmitCache.get(control.frame_seq!)
    if (!cached || now - cached.at > 300 || !s.peer) return
    if (now - this.retransmitWindow >= 1000) { this.retransmitWindow = now; this.retransmitCount = 0 }
    for (const index of new Set(control.missing)) {
      const current = get(this.state), payload = cached.packets[index]
      if (this.retransmitCount >= 128 || !current || current.id !== s.id || current.status !== 'active' || !current.camera || current.peer !== s.peer || this.ownerForPeer(s.peer) !== s.owner) return
      if (!payload) continue
      this.retransmitCount++
      try { await this.endpoint.sendDatagram({ dst: s.peer, srcPort: CALL_PORT, dstPort: CALL_PORT, payload }) } catch { return }
    }
  }
  private tick() {
    const s = get(this.state)
    if (!s || s.status === 'ended') return
    if (s.peers.some(p => this.ownerForPeer(p) !== s.owner)) { this.end('Call ended'); return }
    if (s.status === 'ringing') {
      if (s.direction === 'incoming' && Date.now() - this.lastHeard > 10000) this.end('Connection lost')
      else if (Date.now() - s.started > 30000) this.end('No answer')
      else if (s.direction === 'outgoing') this.broadcast('offer', { video: s.video, codec: CALL_CODEC })
      // Recover a dropped answered-elsewhere/cancel notice without waiting for
      // the incoming ring timeout. The caller alone chooses the winning device.
      else if (Math.floor(Date.now() / 1000) % 3 === 0) this.broadcast('ping')
    } else if (s.status === 'active') {
      if (Date.now() - this.lastHeard > 15000) this.end('Connection lost')
      else if (Math.floor(Date.now() / 1000) % 3 === 0) this.broadcast('ping')
    }
  }
  dispose() { this.end(); clearInterval(this.timer); clearInterval(this.recoveryTimer); this.unregister() }
}

import { writable, get } from 'svelte/store'
import type { CallSettings } from './callSettings'
import { CALL_CODEC, CALL_PORT, CallMediaReceiver, encodeCallControl, encodeCallMedia, parseCallControl, type CallControl, type MediaFrame } from './callProtocol'
export interface CallState {
  id: string; owner: string; peer?: string; peers: string[]; direction: 'incoming' | 'outgoing'
  status: 'ringing' | 'connecting' | 'active' | 'ended'; video: boolean; muted: boolean
  camera: boolean; remoteMuted: boolean; remoteVideo: boolean; started: number; connected?: number; reason?: string
  receivedAudio: number; receivedVideo: number
}
export interface CallEndpoint {
  sendDatagram(args: { dst: string; srcPort: number; dstPort: number; payload: Uint8Array }): Promise<void>
  registerService(port: number, handler: (ctx: { src: string; payload: Uint8Array }) => void): () => void
}
export class CallSession {
  readonly state = writable<CallState | null>(null)
  onMedia?: (frame: MediaFrame) => void
  onEnded?: () => void
  private receiver = new CallMediaReceiver()
  private sequence = [0, 0, 0]
  private ended = new Map<string, number>()
  private lastHeard = 0
  private unregister: () => void
  private timer: ReturnType<typeof setInterval>
  constructor(private endpoint: CallEndpoint, private ownerForPeer: (peer: string) => string | undefined, private settings: () => Pick<CallSettings, 'voice' | 'video'> = () => ({ voice: true, video: true })) {
    this.unregister = endpoint.registerService(CALL_PORT, ({ src, payload }) => { this.receive(src, payload) })
    this.timer = setInterval(() => this.tick(), 1000)
  }
  private rememberEnded(id: string) {
    this.ended.set(id, Date.now())
    while (this.ended.size > 128) this.ended.delete(this.ended.keys().next().value!)
  }
  private send(peer: string, packet: CallControl) {
    void this.endpoint.sendDatagram({ dst: peer, srcPort: CALL_PORT, dstPort: CALL_PORT, payload: encodeCallControl(packet) }).catch(() => {})
  }
  private broadcast(type: CallControl['type'], extra: Partial<CallControl> = {}) {
    const s = get(this.state)
    if (!s) return
    for (const peer of s.peer ? [s.peer] : s.peers) this.send(peer, { v: 1, type, call_id: s.id, video: s.camera, muted: s.muted, ...extra })
  }
  start(owner: string, peers: string[], video: boolean) {
    if (get(this.state)?.status !== 'ended' && get(this.state)) throw new Error('A call is already open')
    if (!peers.length || peers.some(p => this.ownerForPeer(p) !== owner)) throw new Error('This person is not connected. Try again when they are nearby or online.')
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')
    this.receiver = new CallMediaReceiver()
    this.state.set({ id, owner, peers, direction: 'outgoing', status: 'ringing', video, muted: false, camera: video, remoteMuted: false, remoteVideo: video, started: Date.now(), receivedAudio: 0, receivedVideo: 0 })
    this.broadcast('offer', { video, codec: CALL_CODEC })
  }
  accept(video = false) {
    const s = get(this.state)
    if (!s || s.status !== 'ringing' || s.direction !== 'incoming') return
    this.lastHeard = Date.now()
    const withVideo = s.video && video && this.settings().video
    if (!withVideo && !this.settings().voice) return
    this.state.set({ ...s, status: 'active', video: withVideo, camera: withVideo, remoteVideo: withVideo, connected: Date.now() })
    this.broadcast('answer', { video: withVideo, codec: CALL_CODEC })
  }
  end(reason = 'Call ended', notify = true) {
    const s = get(this.state)
    if (!s || s.status === 'ended') return
    if (notify) this.broadcast(s.direction === 'incoming' && s.status === 'ringing' ? 'reject' : 'end')
    this.rememberEnded(s.id)
    this.state.set({ ...s, status: 'ended', reason })
    this.onEnded?.()
  }
  clear() { if (get(this.state)?.status === 'ended') this.state.set(null) }
  setMedia(muted: boolean, camera: boolean) {
    this.state.update(s => s ? { ...s, muted, camera: s.video && camera } : s)
    this.broadcast('media_state', { muted, video: camera })
  }
  async sendMedia(kind: 1 | 2, bytes: Uint8Array) {
    const s = get(this.state)
    if (!s || s.status !== 'active' || !s.peer || (kind === 1 ? s.muted : !s.camera)) return
    for (const payload of encodeCallMedia(s.id, kind, this.sequence[kind]++, bytes)) {
      const current = get(this.state)
      if (current?.status !== 'active' || current.id !== s.id || current.peer !== s.peer) return
      await this.endpoint.sendDatagram({ dst: s.peer, srcPort: CALL_PORT, dstPort: CALL_PORT, payload })
    }
  }
  private receive(peer: string, payload: Uint8Array) {
    const owner = this.ownerForPeer(peer)
    if (!owner) return
    let s = get(this.state)
    const p = parseCallControl(payload)
    if (!p) {
      if (!s || s.status !== 'active' || s.peer !== peer || s.owner !== owner) return
      const frame = this.receiver.receive(s.id, payload)
      if (frame && (frame.kind === 1 || s.video)) {
        this.state.update(current => current ? { ...current, receivedAudio: current.receivedAudio + Number(frame.kind === 1), receivedVideo: current.receivedVideo + Number(frame.kind === 2) } : current)
        this.onMedia?.(frame)
      }
      return
    }
    if (this.ended.has(p.call_id)) {
      if (p.type === 'ping' || p.type === 'offer') this.send(peer, { v: 1, type: 'end', call_id: p.call_id })
      return
    }
    // Datagram order is not guaranteed: a cancelled offer must not ring later.
    if (p.type === 'end' && (!s || s.id !== p.call_id)) {
      this.rememberEnded(p.call_id)
      return
    }
    if (p.type === 'offer') {
      const settings = this.settings()
      if (p.video ? !settings.video && !settings.voice : !settings.voice) {
        this.rememberEnded(p.call_id)
        this.send(peer, { v: 1, type: 'reject', call_id: p.call_id }); return
      }
      if (s && s.status === 'ringing' && s.direction === 'outgoing' && s.owner === owner && p.call_id < s.id) {
        this.end('Call ended')
        s = get(this.state)
      }
      if (s && s.status !== 'ended') {
        if (s.id === p.call_id && s.peer === peer && s.status === 'active') this.broadcast('answer', { video: s.video, codec: CALL_CODEC })
        else if (s.id !== p.call_id) {
          this.rememberEnded(p.call_id)
          this.send(peer, { v: 1, type: 'reject', call_id: p.call_id, reason: 'busy' })
        }
        return
      }
      this.receiver = new CallMediaReceiver()
      this.state.set({ id: p.call_id, owner, peer, peers: [peer], direction: 'incoming', status: 'ringing', video: !!p.video, muted: false, camera: !!p.video, remoteMuted: false, remoteVideo: !!p.video, started: Date.now(), receivedAudio: 0, receivedVideo: 0 })
      return
    }
    if (!s || s.id !== p.call_id || s.owner !== owner || !s.peers.includes(peer) || (s.peer && s.peer !== peer)) return
    this.lastHeard = Date.now()
    if (p.type === 'answer' && s.direction === 'outgoing' && s.status === 'ringing') {
      for (const other of s.peers) if (other !== peer) this.send(other, { v: 1, type: 'end', call_id: s.id })
      this.state.set({ ...s, status: 'active', peer, connected: Date.now(), video: s.video && !!p.video, camera: s.camera && !!p.video, remoteVideo: s.video && !!p.video })
    } else if (p.type === 'reject' || p.type === 'end') {
      if (!s.peer && p.type === 'reject' && s.peers.length > 1) this.state.set({ ...s, peers: s.peers.filter(x => x !== peer) })
      else this.end(p.type === 'reject' ? (p.reason === 'busy' ? 'Busy' : 'Call declined') : 'Call ended', false)
    } else if (p.type === 'ping' || p.type === 'pong' || p.type === 'media_state') {
      this.state.set({ ...s, remoteMuted: p.muted ?? s.remoteMuted, remoteVideo: s.video && (p.video ?? s.remoteVideo) })
      if (p.type === 'ping') this.broadcast('pong')
    }
  }
  private tick() {
    const s = get(this.state)
    if (!s || s.status === 'ended') return
    if (s.peers.some(p => this.ownerForPeer(p) !== s.owner)) { this.end('Call ended'); return }
    if (s.status === 'ringing') {
      if (Date.now() - s.started > 30000) this.end('No answer')
      else if (s.direction === 'outgoing') this.broadcast('offer', { video: s.video, codec: CALL_CODEC })
    } else if (s.status === 'active') {
      if (Date.now() - this.lastHeard > 15000) this.end('Connection lost')
      else if (Math.floor(Date.now() / 1000) % 3 === 0) this.broadcast('ping')
    }
  }
  dispose() { this.end(); clearInterval(this.timer); this.unregister() }
}

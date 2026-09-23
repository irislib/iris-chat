import { callEncoding, callVideoSize, type CallQualitySettings } from './callQuality'
import { CallAdaptation } from './callAdaptation'
import { callAudioWorklet } from './callAudioWorklet'
import { CallOpus } from './callOpus'
import type { CallControl, MediaFrame } from './callProtocol'

export interface CallMediaStats {
  receivedAudio: number; receivedVideo: number; sentBytes: number; receivedBytes: number
  audioEnergy: number; concealedAudio: number; videoWidth: number; videoHeight: number
  targetBitrate: number; sentVideoFrames: number; droppedVideoFrames: number
}
export interface CallMediaCallbacks {
  send(frame: MediaFrame): Promise<void>
  remoteVideo(canvas: HTMLCanvasElement): void
  feedback(feedback: Pick<CallControl, 'feedback_seq' | 'video_seq' | 'received_frames' | 'received_bytes' | 'interval_ms'>): void
  highestVideo(): number | undefined
  requestKeyframe(): void
  stats?(stats: CallMediaStats): void
  error?(error: Error): void
}
const audioConfig: AudioEncoderConfig & { opus: OpusEncoderConfig & { application: 'voip' } } = { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 32000, opus: { format: 'opus', application: 'voip', frameDuration: 20000, useinbandfec: true, usedtx: true, packetlossperc: 10 } }
const unsupported = () => new Error('This browser cannot make video calls. Update your browser and try again.')
/** Browser codecs only: every encoded packet is sent through the authenticated call session. */
export class BrowserCallMedia {
  stream: MediaStream | null = null
  private generation = 0
  private quality: CallQualitySettings = {}
  private qualityRevision = 0
  private active = false
  private camera = false
  private muted = false
  private audioContext?: AudioContext
  private audioNode?: AudioWorkletNode
  private audioEncoder?: AudioEncoder
  private opus?: CallOpus
  private videoEncoder?: VideoEncoder
  private videoDecoder?: VideoDecoder
  private decoderInit?: VideoDecoderInit
  private capture?: HTMLVideoElement
  private canvas?: HTMLCanvasElement
  private encodeCanvas?: HTMLCanvasElement
  private captureTimer?: ReturnType<typeof setInterval>
  private audioTimer?: ReturnType<typeof setInterval>
  private statsTimer?: ReturnType<typeof setInterval>
  private epoch = 0
  private audioSeq = 0
  private videoSeq = 0
  private videoAttempts = new Map<number, number>()
  private videoSending = false
  private lastKey = -Infinity
  private forceKey = true
  private needKey = true
  private lastRemoteVideo?: number
  private lastRequest = -Infinity
  private lastLocalRequest = -Infinity
  private audioQueue = new Map<number, MediaFrame>()
  private audioNext?: number
  private audioDue = 0
  private lastAudioAt = 0
  private videoQueue: Array<{ frame: MediaFrame; arrived: number }> = []
  private playoutOffset?: number
  private renderTimers = new Map<ReturnType<typeof setTimeout>, VideoFrame>()
  private adaptation = new CallAdaptation(2_000_000)
  private feedbackSequence = 0
  private feedbackFrames = 0
  private feedbackBytes = 0
  private feedbackAt = 0
  private configuredBitrate = 0
  private stats: CallMediaStats = { receivedAudio: 0, receivedVideo: 0, sentBytes: 0, receivedBytes: 0, audioEnergy: 0, concealedAudio: 0, videoWidth: 0, videoHeight: 0, targetBitrate: 0, sentVideoFrames: 0, droppedVideoFrames: 0 }
  constructor(private callbacks: CallMediaCallbacks) {}

  async open(video: boolean, quality: CallQualitySettings = {}) {
    this.stop()
    const token = this.generation
    this.quality = quality
    this.adaptation = new CallAdaptation(callEncoding(quality).maxBitrate)
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioWorkletNode) throw new Error('Microphone unavailable. Open Iris in a secure, up-to-date browser.')
    if (video) {
      if (!globalThis.VideoEncoder || !globalThis.VideoDecoder) throw unsupported()
      const config = this.videoConfig()
      if (!(await VideoEncoder.isConfigSupported(config)).supported || !(await VideoDecoder.isConfigSupported({ codec: 'avc1.42e028', optimizeForLatency: true })).supported) throw unsupported()
    }
    const opus = await CallOpus.open()
    if (token !== this.generation) { opus.close(); throw new Error('Call ended') }
    this.opus = opus
    try {
      const size = callEncoding(quality)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000 }, video: video ? { width: { ideal: size.width }, height: { ideal: size.height }, frameRate: { ideal: size.maxFramerate, max: 30 } } : false })
      if (token !== this.generation) { stream.getTracks().forEach(track => track.stop()); throw new Error('Call ended') }
      this.stream = stream
      stream.getTracks().forEach(track => { track.enabled = false })
      const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
      this.audioContext = context
      const workletUrl = URL.createObjectURL(new Blob([callAudioWorklet], { type: 'text/javascript' }))
      try { await context.audioWorklet.addModule(workletUrl) } finally { URL.revokeObjectURL(workletUrl) }
      if (token !== this.generation) throw new Error('Call ended')
      const node = new AudioWorkletNode(context, 'iris-call-audio', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
      this.audioNode = node
      context.createMediaStreamSource(stream).connect(node)
      node.connect(context.destination)
      const browserOpus = globalThis.AudioEncoder && (await AudioEncoder.isConfigSupported(audioConfig)).supported
      if (token !== this.generation) throw new Error('Call ended')
      if (browserOpus) {
        const encoder = new AudioEncoder({ output: chunk => {
          if (token !== this.generation || !this.active) return
          const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes)
          this.send({ kind: 1, seq: this.audioSeq++ >>> 0, timestamp: Math.max(0, chunk.timestamp), key: true, bytes })
        }, error: error => this.fail(error, token) })
        encoder.configure(audioConfig)
        this.audioEncoder = encoder
      }
      if (token !== this.generation) throw new Error('Call ended')
      node.port.onmessage = event => {
        if (token !== this.generation || !this.active || this.muted) return
        const pcm: Float32Array<ArrayBuffer> = event.data.pcm
        const timestamp = Math.max(0, Math.round((performance.now() - this.epoch) * 1000) - 20000)
        if (this.audioEncoder) {
          if (this.audioEncoder.encodeQueueSize > 3) return
          const data = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: pcm.length, numberOfChannels: 1, timestamp, data: pcm })
          this.audioEncoder.encode(data); data.close()
        } else this.send({ kind: 1, seq: this.audioSeq++ >>> 0, timestamp, key: true, bytes: opus.encode(pcm) })
      }
      if (video) this.openVideo(stream, token)
      this.epoch = performance.now()
      this.feedbackAt = this.epoch
      this.audioTimer = setInterval(() => this.playout(), 10)
      this.statsTimer = setInterval(() => this.report(), 1000)
      await context.resume()
    } catch (error) { if (token === this.generation) this.stop(); throw error }
  }
  private videoConfig(): VideoEncoderConfig {
    const quality = callEncoding(this.quality)
    const capture = this.stream?.getVideoTracks()[0]?.getSettings()
    return { codec: quality.codec, ...callVideoSize(this.quality, capture), bitrate: this.adaptation.target, framerate: quality.maxFramerate, latencyMode: 'realtime', bitrateMode: 'variable', avc: { format: 'annexb' } }
  }
  private openVideo(stream: MediaStream, token: number) {
    const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.srcObject = stream; void video.play().catch(() => {})
    this.capture = video
    this.canvas = document.createElement('canvas')
    this.encodeCanvas = document.createElement('canvas')
    this.callbacks.remoteVideo(this.canvas)
    this.videoEncoder = new VideoEncoder({ output: chunk => {
      const seq = this.videoAttempts.get(chunk.timestamp); this.videoAttempts.delete(chunk.timestamp)
      if (token !== this.generation || !this.active || !this.camera || seq === undefined) return
      if (this.videoSending || (performance.now() - this.epoch) * 1000 - chunk.timestamp > 150000) { this.stats.droppedVideoFrames++; this.forceKey = true; return }
      const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes)
      if (bytes.length > 262144) { this.forceKey = true; return }
      this.videoSending = true
      this.stats.sentVideoFrames++
      void this.send({ kind: 2, seq, timestamp: chunk.timestamp, key: chunk.type === 'key', bytes }).finally(() => { if (token === this.generation) this.videoSending = false })
    }, error: error => this.fail(error, token) })
    this.videoEncoder.configure(this.videoConfig()); this.configuredBitrate = this.adaptation.target
    this.decoderInit = { output: frame => {
      if (token !== this.generation || !this.active || !this.canvas) { frame.close(); return }
      const draw = () => {
        if (token === this.generation && this.active && this.canvas) {
          if (this.canvas.width !== frame.displayWidth) this.canvas.width = frame.displayWidth
          if (this.canvas.height !== frame.displayHeight) this.canvas.height = frame.displayHeight
          this.canvas.getContext('2d')!.drawImage(frame, 0, 0)
          this.stats.receivedVideo++; this.stats.videoWidth = frame.displayWidth; this.stats.videoHeight = frame.displayHeight
        }
        frame.close()
      }
      const delay = Math.min(100, Math.max(0, frame.timestamp / 1000 + (this.playoutOffset ?? 0) - performance.now()))
      const timer = setTimeout(() => { this.renderTimers.delete(timer); draw() }, delay)
      this.renderTimers.set(timer, frame)
    }, error: () => { if (token === this.generation) { this.needKey = true; this.requestKey() } } }
    this.videoDecoder = new VideoDecoder(this.decoderInit)
    this.videoDecoder.configure({ codec: 'avc1.42e028', optimizeForLatency: true })
    let last = 0
    this.captureTimer = setInterval(() => {
      if (!this.active || !this.camera || token !== this.generation || video.readyState < 2) return
      const now = performance.now(), quality = callEncoding(this.quality)
      if (now - last < 1000 / quality.maxFramerate - 2) return
      last = now
      const seq = this.videoSeq++ >>> 0
      this.adaptation.sentFrame()
      if (!this.videoEncoder || this.videoEncoder.state !== 'configured' || this.videoEncoder.encodeQueueSize > 1 || this.videoSending) { this.stats.droppedVideoFrames++; return }
      const canvas = this.encodeCanvas!
      const config = this.videoConfig()
      if (canvas.width !== config.width) canvas.width = config.width
      if (canvas.height !== config.height) canvas.height = config.height
      canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height)
      const timestamp = Math.round((now - this.epoch) * 1000)
      const frame = new VideoFrame(canvas, { timestamp })
      const keyFrame = this.forceKey || now - this.lastKey >= 1000
      if (keyFrame) { this.forceKey = false; this.lastKey = now }
      this.videoAttempts.set(timestamp, seq)
      this.videoEncoder.encode(frame, { keyFrame }); frame.close()
    }, 10)
  }
  private async send(frame: MediaFrame) {
    this.stats.sentBytes += frame.bytes.length
    try { await this.callbacks.send(frame) } catch { /* Loss is recovered by codec concealment/keyframe feedback. */ }
  }
  receive(frame: MediaFrame) {
    if (!this.active) return
    const now = performance.now()
    this.stats.receivedBytes += frame.bytes.length
    this.playoutOffset ??= now + 60 - frame.timestamp / 1000
    if (frame.kind === 1) {
      if (this.audioNext !== undefined && ((frame.seq - this.audioNext) >>> 0) >= 0x80000000) return
      this.audioQueue.set(frame.seq, frame)
      if (this.audioNext === undefined || now - this.lastAudioAt > 200) { this.audioNext = frame.seq; this.audioDue = now + 40 }
      this.lastAudioAt = now
      while (this.audioQueue.size > 16) this.audioQueue.delete(this.audioQueue.keys().next().value!)
    } else {
      this.feedbackFrames++; this.feedbackBytes += frame.bytes.length
      if (this.lastRemoteVideo !== undefined && ((frame.seq - this.lastRemoteVideo) >>> 0) >= 0x80000000) return
      this.videoQueue.push({ frame, arrived: now })
      this.videoQueue.sort((a, b) => a.frame.timestamp - b.frame.timestamp)
      if (this.videoQueue.length > 3) { this.videoQueue.shift(); this.needKey = true; this.requestKey() }
    }
  }
  private playout() {
    if (!this.active) return
    const now = performance.now()
    if (this.audioNext !== undefined && now >= this.audioDue && now - this.lastAudioAt < 200) {
      const frame = this.audioQueue.get(this.audioNext), next = this.audioQueue.get((this.audioNext + 1) >>> 0)
      const pcm = this.opus?.decode(frame?.bytes ?? next?.bytes, !frame && !!next)
      this.audioQueue.delete(this.audioNext); this.audioNext = (this.audioNext + 1) >>> 0; this.audioDue = Math.max(this.audioDue + 20, now - 20)
      if (pcm) {
        if (frame) { this.stats.receivedAudio++; this.stats.audioEnergy += pcm.reduce((sum, sample) => sum + sample * sample, 0) / 48000 }
        else this.stats.concealedAudio++
        this.audioNode?.port.postMessage({ pcm }, [pcm.buffer])
      }
    }
    while (this.videoQueue.length && now - this.videoQueue[0].arrived >= 50) {
      const { frame } = this.videoQueue.shift()!
      const gap = this.lastRemoteVideo !== undefined && frame.seq !== ((this.lastRemoteVideo + 1) >>> 0)
      if (gap) { this.needKey = true; this.requestKey() }
      this.lastRemoteVideo = frame.seq
      if (this.needKey && !frame.key) continue
      if (!this.videoDecoder || this.videoDecoder.decodeQueueSize > 3) { this.needKey = true; this.requestKey(); continue }
      if (frame.key) {
        if (this.videoDecoder.state === 'closed') this.openDecoderAgain()
        this.needKey = false
      }
      try { this.videoDecoder.decode(new EncodedVideoChunk({ type: frame.key ? 'key' : 'delta', timestamp: frame.timestamp, data: frame.bytes })) }
      catch { this.needKey = true; this.requestKey() }
    }
  }
  private openDecoderAgain() {
    // Decoder errors invalidate references. A new keyframe starts a fresh decoder.
    const previous = this.videoDecoder
    if (!previous || previous.state !== 'closed') return
    this.videoDecoder = new VideoDecoder(this.decoderInit!)
    this.videoDecoder.configure({ codec: 'avc1.42e028', optimizeForLatency: true })
  }
  private requestKey() { const now = performance.now(); if (now - this.lastRequest >= 1000) { this.lastRequest = now; this.callbacks.requestKeyframe() } }
  requestKeyframe() { const now = performance.now(); if (now - this.lastLocalRequest >= 1000) { this.lastLocalRequest = now; this.forceKey = true } }
  feedback(feedback: CallControl) { if (this.active && this.camera) { this.adaptation.feedback(feedback); this.configureBitrate() } }
  private configureBitrate() {
    if (this.videoEncoder?.state === 'configured' && this.configuredBitrate !== this.adaptation.target) {
      this.videoEncoder.configure(this.videoConfig()); this.configuredBitrate = this.adaptation.target; this.forceKey = true
    }
  }
  private report() {
    if (!this.active) return
    const now = performance.now()
    if (this.camera) { this.adaptation.tick(now); this.configureBitrate() }
    this.callbacks.feedback({ feedback_seq: this.feedbackSequence++ >>> 0, video_seq: this.callbacks.highestVideo(), received_frames: this.feedbackFrames, received_bytes: this.feedbackBytes, interval_ms: Math.max(200, Math.min(5000, Math.round(now - this.feedbackAt))) })
    this.feedbackAt = now; this.feedbackFrames = 0; this.feedbackBytes = 0
    this.stats.targetBitrate = this.adaptation.target
    this.callbacks.stats?.({ ...this.stats })
  }
  setState(active: boolean, muted: boolean, camera: boolean, videoAllowed: boolean) {
    if (active && !this.active) { this.epoch = performance.now(); this.adaptation.begin(this.epoch) }
    if (camera && !this.camera) this.forceKey = true
    this.active = active; this.muted = muted; this.camera = camera && videoAllowed
    this.stream?.getAudioTracks().forEach(track => { track.enabled = active && !muted })
    this.stream?.getVideoTracks().forEach(track => { if (!videoAllowed) track.stop(); else track.enabled = active && camera })
    this.audioNode?.port.postMessage({ active: active && !muted })
  }
  async setQuality(quality: CallQualitySettings) {
    const revision = ++this.qualityRevision, token = this.generation
    const old = callEncoding(this.quality), next = callEncoding(quality)
    if (this.videoEncoder && (old.width !== next.width || old.codec !== next.codec)) {
      const config = { ...this.videoConfig(), width: next.width, height: next.height, codec: next.codec }
      if (!(await VideoEncoder.isConfigSupported(config)).supported) throw unsupported()
    }
    if (revision !== this.qualityRevision || token !== this.generation) return
    this.quality = quality; this.adaptation.setCap(next.maxBitrate)
    this.configureBitrate()
    if (this.videoEncoder?.state === 'configured' && (old.width !== next.width || old.maxFramerate !== next.maxFramerate)) {
      await this.stream?.getVideoTracks()[0]?.applyConstraints({ width: { ideal: next.width }, height: { ideal: next.height }, frameRate: { ideal: next.maxFramerate, max: 30 } })
      if (revision === this.qualityRevision && token === this.generation && this.videoEncoder?.state === 'configured') { this.videoEncoder.configure(this.videoConfig()); this.forceKey = true }
    }
  }
  private fail(error: Error, token: number) { if (token === this.generation) this.callbacks.error?.(error) }
  stop() {
    this.generation++; this.active = false
    clearInterval(this.captureTimer); clearInterval(this.audioTimer); clearInterval(this.statsTimer)
    for (const [timer, frame] of this.renderTimers) { clearTimeout(timer); frame.close() }
    this.renderTimers.clear()
    this.audioNode?.disconnect(); this.audioNode = undefined
    void this.audioContext?.close().catch(() => {}); this.audioContext = undefined
    if (this.audioEncoder && this.audioEncoder.state !== 'closed') this.audioEncoder.close()
    if (this.videoEncoder && this.videoEncoder.state !== 'closed') this.videoEncoder.close()
    if (this.videoDecoder && this.videoDecoder.state !== 'closed') this.videoDecoder.close()
    this.audioEncoder = undefined; this.videoEncoder = undefined; this.videoDecoder = undefined
    this.opus?.close(); this.opus = undefined
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null
    if (this.capture) { this.capture.pause(); this.capture.srcObject = null; this.capture = undefined }
    this.canvas = undefined; this.encodeCanvas = undefined
    this.audioQueue.clear(); this.videoQueue = []; this.videoAttempts.clear()
  }
}

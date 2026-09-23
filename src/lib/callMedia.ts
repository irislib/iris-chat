import type { MediaFrame } from './callProtocol'
/** A deliberately small interoperable codec: mono PCM 16 kHz and 320×240 JPEG. */
export class BrowserCallMedia {
  stream: MediaStream | null = null
  private audio: AudioContext | null = null
  private processor: ScriptProcessorNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private video: HTMLVideoElement | null = null
  private videoTimer: ReturnType<typeof setInterval> | null = null
  private videoBusy = false
  private audioBusy = false
  private playAt = 0
  private samples: number[] = []
  private generation = 0
  private active = false
  muted = false
  camera = false
  constructor(private send: (kind: 1 | 2, bytes: Uint8Array) => Promise<void>, private remoteVideo: (url: string) => void) {}
  async open(video: boolean) {
    this.stop()
    const generation = this.generation
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: video ? { width: { ideal: 320, max: 320 }, height: { ideal: 240, max: 240 }, frameRate: { ideal: 8, max: 8 } } : false })
    if (generation !== this.generation) { stream.getTracks().forEach(t => t.stop()); throw new Error('Call ended') }
    this.stream = stream
    this.camera = video
    this.audio = new AudioContext({ sampleRate: 16000 })
    await this.audio.resume()
    this.source = this.audio.createMediaStreamSource(stream)
    this.processor = this.audio.createScriptProcessor(256, 1, 1)
    this.source.connect(this.processor)
    // A connected output is required to drive the processor; output stays silent.
    this.processor.connect(this.audio.destination)
    this.processor.onaudioprocess = event => {
      if (!this.active || this.muted) { this.samples = []; return }
      const data = event.inputBuffer.getChannelData(0)
      const stride = event.inputBuffer.sampleRate / 16000
      for (let i = 0; i < data.length; i += stride) this.samples.push(data[Math.floor(i)])
      while (this.samples.length >= 320) {
        const block = this.samples.splice(0, 320)
        if (this.audioBusy) continue
        const bytes = new Uint8Array(640), view = new DataView(bytes.buffer)
        block.forEach((x, i) => view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, x)) * 32767), true))
        this.audioBusy = true
        void this.send(1, bytes).catch(() => {}).finally(() => { this.audioBusy = false })
      }
    }
    if (video) {
      const element = document.createElement('video')
      element.muted = true; element.playsInline = true; element.srcObject = stream
      this.video = element
      await element.play()
      const canvas = document.createElement('canvas')
      canvas.width = 320; canvas.height = 240
      const context = canvas.getContext('2d')!
      this.videoTimer = setInterval(() => {
        if (!this.active || !this.camera || this.videoBusy || element.readyState < 2) return
        this.videoBusy = true
        context.drawImage(element, 0, 0, 320, 240)
        canvas.toBlob(blob => {
          if (!blob || generation !== this.generation) { this.videoBusy = false; return }
          void blob.arrayBuffer().then(buffer => {
            if (generation === this.generation && this.active && this.camera) return this.send(2, new Uint8Array(buffer))
          }).catch(() => {}).finally(() => { this.videoBusy = false })
        }, 'image/jpeg', 0.55)
      }, 125)
    }
  }
  setState(active: boolean, muted: boolean, camera: boolean, videoAllowed: boolean) {
    this.active = active; this.muted = muted; this.camera = camera
    this.stream?.getAudioTracks().forEach(t => { t.enabled = !muted })
    this.stream?.getVideoTracks().forEach(t => { if (!videoAllowed) t.stop(); else t.enabled = camera })
  }
  receive(frame: MediaFrame) {
    if (frame.kind === 1 && this.audio) {
      const buffer = this.audio.createBuffer(1, 320, 16000)
      const data = buffer.getChannelData(0), view = new DataView(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.length)
      for (let i = 0; i < 320; i++) data[i] = view.getInt16(i * 2, true) / 32768
      const now = this.audio.currentTime
      // Keep latency bounded even if the link delivers a burst after a stall.
      if (this.playAt > now + 0.2) return
      this.playAt = Math.max(now + 0.025, this.playAt)
      const source = this.audio.createBufferSource()
      source.buffer = buffer; source.connect(this.audio.destination); source.start(this.playAt)
      this.playAt += 0.02
    } else if (frame.kind === 2) {
      this.remoteVideo(URL.createObjectURL(new Blob([new Uint8Array(frame.bytes)], { type: 'image/jpeg' })))
    }
  }
  stop() {
    this.generation++; this.active = false
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = null
    this.processor?.disconnect(); this.processor = null
    this.source?.disconnect(); this.source = null
    void this.audio?.close().catch(() => {}); this.audio = null
    if (this.video) { this.video.pause(); this.video.srcObject = null; this.video = null }
    if (this.videoTimer) clearInterval(this.videoTimer)
    this.videoTimer = null; this.samples = []; this.playAt = 0
  }
}

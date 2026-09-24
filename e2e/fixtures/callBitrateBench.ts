import { get } from 'svelte/store'
import { BrowserCallMedia, type CallMediaStats } from '../../src/lib/callMedia'
import { CallSession, type CallEndpoint } from '../../src/lib/callSession'

/** A serial, bounded datagram link. Audio, video, controls and repairs share its budget. */
class LimitedLink {
  bps = 4_000_000
  delayMs = 20
  jitterMs = 0
  dropEvery = 0
  dropFeedback = false
  offered = 0
  delivered = 0
  dropped = 0
  private tail = 0
  private sequence = 0
  private timers = new Set<ReturnType<typeof setTimeout>>()
  constructor(private deliver: (bytes: Uint8Array) => void) {}
  send(bytes: Uint8Array) {
    const now = performance.now(), size = bytes.length + 80 // encrypted transport/IP allowance
    this.offered += size
    if (this.dropFeedback && bytes[0] === 123 && new TextDecoder().decode(bytes).includes('"type":"feedback"')) return
    const finish = Math.max(now, this.tail) + size * 8000 / this.bps
    this.sequence++
    if (finish - now > 120 || (this.dropEvery && this.sequence % this.dropEvery === 0)) { this.dropped++; return }
    this.tail = finish
    const timer = setTimeout(() => {
      this.timers.delete(timer); this.delivered += size; this.deliver(bytes)
    }, finish - now + this.delayMs + (this.sequence % 7) / 6 * this.jitterMs)
    this.timers.add(timer)
  }
  stop() { for (const timer of this.timers) clearTimeout(timer); this.timers.clear() }
}

export async function startBitrateBench() {
  const media: BrowserCallMedia[] = [], sessions: CallSession[] = []
  const stats: Array<CallMediaStats | undefined> = []
  const errors: string[] = []
  const samples: Array<{ side: number; at: number; stats: CallMediaStats }> = []
  const renders: Array<Array<{ at: number; age: number }>> = [[], []]
  const encoded: Array<Array<{ at: number; size: number; key: boolean }>> = [[], []]
  const origins = [0, 0]
  const sources: Array<{ stream: MediaStream; audio: AudioContext; timer: ReturnType<typeof setInterval> }> = []
  const handlers: Array<((ctx: { src: string; payload: Uint8Array }) => void) | undefined> = []
  const links = [0, 1].map(side => new LimitedLink(payload => handlers[1 - side]?.({ src: `peer-${side}`, payload })))
  const originalCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  // Synthetic moving camera and audible tone; all downstream codecs are production code.
  navigator.mediaDevices.getUserMedia = async constraints => {
    const audio = new AudioContext({ sampleRate: 48000 })
    const oscillator = audio.createOscillator(), gain = audio.createGain(), sink = audio.createMediaStreamDestination()
    gain.gain.value = .2; oscillator.frequency.value = 440
    oscillator.connect(gain); gain.connect(sink); oscillator.start(); await audio.resume()
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720
    const context = canvas.getContext('2d')!; let frame = 0
    const draw = () => {
      frame++; context.fillStyle = '#27424d'; context.fillRect(0, 0, canvas.width, canvas.height)
      for (let i = 0; i < 40; i++) {
        context.fillStyle = `hsl(${i * 17 + frame},70%,55%)`
        context.fillRect((i * 97 + frame * 5) % canvas.width, (i * 71 + frame * 3) % canvas.height, 110, 70)
      }
    }
    draw()
    const stream = new MediaStream([...sink.stream.getAudioTracks(), ...canvas.captureStream(30).getVideoTracks()])
    sources.push({ stream, audio, timer: setInterval(draw, 33) })
    if (!constraints?.video) throw new Error('Benchmark needs video')
    return stream
  }
  for (let side = 0; side < 2; side++) {
    const endpoint: CallEndpoint = {
      sendDatagram: async ({ payload }) => { links[side].send(payload) },
      registerService: (_, handler) => { handlers[side] = handler; return () => { handlers[side] = undefined } },
    }
    const session = new CallSession(endpoint, peer => peer === `peer-${1 - side}` ? `user-${1 - side}` : undefined)
    sessions.push(session)
    const engine = new BrowserCallMedia({
      send: frame => { if (frame.kind === 2) encoded[side].push({ at: performance.now(), size: frame.bytes.length, key: frame.key }); return session.sendMedia(frame) },
      feedback: value => session.sendFeedback(value), highestVideo: () => session.highestVideo,
      requestKeyframe: () => session.requestKeyframe(),
      error: error => errors.push(error.message),
      stats: value => { stats[side] = value; samples.push({ side, at: performance.now(), stats: value }) },
      remoteVideo: canvas => {
        document.body.appendChild(canvas); canvas.style.width = '320px'
        const context = canvas.getContext('2d')!, draw = context.drawImage.bind(context)
        context.drawImage = ((image: CanvasImageSource, ...args: number[]) => {
          if (image instanceof VideoFrame) renders[side].push({ at: performance.now(), age: performance.now() - origins[1 - side] - image.timestamp / 1000 })
          ;(draw as (...values: unknown[]) => void)(image, ...args)
        }) as typeof context.drawImage
      },
    })
    media.push(engine)
    session.onMedia = frame => engine.receive(frame)
    session.onFeedback = value => engine.feedback(value)
    session.onKeyframe = () => engine.requestKeyframe()
  }
  const stop = () => {
    sessions.forEach(session => session.dispose()); media.forEach(engine => engine.stop()); links.forEach(link => link.stop())
    sources.forEach(source => { clearInterval(source.timer); source.stream.getTracks().forEach(track => track.stop()); void source.audio.close() })
    navigator.mediaDevices.getUserMedia = originalCapture
  }
  try {
    await Promise.all(media.map(engine => engine.open(true)))
    sessions[0].start('user-1', ['peer-1'], true)
    const deadline = performance.now() + 5000
    while (get(sessions[1].state)?.status !== 'ringing') {
      if (performance.now() > deadline) throw new Error('Call offer did not arrive')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    sessions[1].accept(true)
    while (get(sessions[0].state)?.status !== 'active') {
      if (performance.now() > deadline) throw new Error('Call answer did not arrive')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    media.forEach((engine, side) => { origins[side] = performance.now(); engine.setState(true, false, true, true); sessions[side].markMediaReady() })
    return {
      stop, errors, samples,
      resume: () => { sources.forEach(source => { void source.audio.resume() }) },
      async phase(name: string, rates: number[], seconds: number, dropEvery = 0, dropFeedback = false, jitterMs = 0) {
        links.forEach((link, side) => { link.bps = rates[side]; link.dropEvery = dropEvery; link.dropFeedback = dropFeedback; link.jitterMs = jitterMs })
        const began = performance.now(), snapshots: Array<{ side: number; at: number; stats: CallMediaStats }> = []
        const before = links.map(link => ({ delivered: link.delivered, offered: link.offered, dropped: link.dropped }))
        while (performance.now() - began < seconds * 1000) {
          await new Promise(resolve => setTimeout(resolve, 100))
          stats.forEach((value, side) => { if (value) snapshots.push({ side, at: performance.now(), stats: { ...value } }) })
        }
        const end = performance.now(), windowStart = end - 5000
        return {
          name, rates, errors: [...errors], states: sessions.map(session => get(session.state)?.status),
          peers: [0, 1].map(side => {
            const recent = renders[side].filter(frame => frame.at >= windowStart && frame.at <= end)
            const times = [windowStart, ...recent.map(frame => frame.at), end]
            const ages = recent.map(frame => frame.age).sort((a, b) => a - b)
            const initial = snapshots.find(sample => sample.side === side && sample.at >= windowStart)?.stats
            const last = stats[side]!
            const targets = samples.filter(sample => sample.side === side && sample.at >= began).map(sample => ({ afterMs: sample.at - began, bps: sample.stats.targetBitrate }))
            return {
              side, target: last.targetBitrate, targets, decodedFps: recent.length / 5,
              dimensions: [last.videoWidth, last.videoHeight], droppedCaptures: last.droppedVideoFrames - (initial?.droppedVideoFrames ?? 0),
              encodedFps: encoded[side].filter(frame => frame.at >= windowStart).length / 5,
              maxKeyBytes: Math.max(0, ...encoded[side].filter(frame => frame.at >= windowStart && frame.key).map(frame => frame.size)),
              maxFreezeMs: Math.max(...times.slice(1).map((time, index) => time - times[index])),
              p95FrameAgeMs: ages[Math.floor(ages.length * .95)] ?? null,
              audioFps: (last.receivedAudio - (initial?.receivedAudio ?? last.receivedAudio)) / 5,
              payloadBps: (last.sentBytes - (initial?.sentBytes ?? last.sentBytes)) * 8 / 5,
              droppedPackets: links[side].dropped - before[side].dropped,
              wireBps: (links[side].delivered - before[side].delivered) * 8 / ((end - began) / 1000),
            }
          }),
        }
      },
    }
  } catch (error) { stop(); throw error }
}

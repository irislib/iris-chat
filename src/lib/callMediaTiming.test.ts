import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserCallMedia, type CallMediaCallbacks } from './callMedia'
import type { MediaFrame } from './callProtocol'

const codec = vi.hoisted(() => ({
  encode: vi.fn(() => new Uint8Array([7])),
  decode: vi.fn(() => new Float32Array(960)),
  close: vi.fn(),
}))
vi.mock('./callOpus', () => ({ CallOpus: { open: async () => codec } }))

let node: { port: { onmessage?: (event: { data: object }) => void; postMessage: ReturnType<typeof vi.fn> } }
let media: BrowserCallMedia
let send: ReturnType<typeof vi.fn>
const audio = (seq: number): MediaFrame => ({ kind: 1, seq, timestamp: seq * 20000, key: true, bytes: new Uint8Array([seq]) })
const event = (data: object) => node.port.onmessage!({ data })

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] })
  vi.clearAllMocks()
  const track = { enabled: false, stop: vi.fn() }
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] }) } })
  vi.stubGlobal('AudioContext', class {
    get currentTime() { return performance.now() / 1000 }
    audioWorklet = { addModule: async () => {} }
    createMediaStreamSource = () => ({ connect: () => {} })
    resume = async () => {}
    close = async () => {}
  })
  vi.stubGlobal('AudioWorkletNode', class {
    port = { onmessage: undefined, postMessage: vi.fn() }
    constructor() { node = this }
    connect() {}
    disconnect() {}
  })
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:call-audio', revokeObjectURL: () => {} })
  send = vi.fn(async () => {})
  media = new BrowserCallMedia({ send, feedback: vi.fn(), highestVideo: () => undefined } as unknown as CallMediaCallbacks)
  await media.open(false)
  media.setState(true, false, false, false)
})

afterEach(() => { media?.stop(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('device-paced browser call media', () => {
  it('decodes only when the audio rendering thread asks for its next block', () => {
    media.receive(audio(0))
    vi.advanceTimersByTime(60)
    expect(codec.decode).not.toHaveBeenCalled()
    event({ playout: .06 })
    expect(codec.decode).toHaveBeenCalledExactlyOnceWith(new Uint8Array([0]), false)
    expect(node.port.postMessage).toHaveBeenCalledWith({ pcm: expect.any(Float32Array) }, expect.any(Array))
  })

  it('drops stale microphone transfers instead of timestamping them as fresh speech', () => {
    vi.advanceTimersByTime(200)
    event({ pcm: new Float32Array(960), capturedAt: 0 })
    expect(send).not.toHaveBeenCalled()
    expect(node.port.postMessage).toHaveBeenCalledWith({ captured: true })
    event({ pcm: new Float32Array(960), capturedAt: .18 })
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0][0].timestamp).toBe(180000)
  })

  it('acknowledges microphone transfers while muted so unmuting cannot deadlock capture', () => {
    media.setState(true, true, false, false)
    event({ pcm: new Float32Array(960), capturedAt: 0 })
    expect(send).not.toHaveBeenCalled()
    expect(node.port.postMessage).toHaveBeenCalledWith({ captured: true })
  })

  it('advances the jitter window when old packets are evicted', () => {
    for (let seq = 0; seq < 32; seq++) media.receive(audio(seq))
    vi.advanceTimersByTime(60)
    event({ playout: .06 })
    expect(codec.decode).toHaveBeenCalledExactlyOnceWith(new Uint8Array([16]), false)
  })

  it('acknowledges stale device deadlines without decoding obsolete audio', () => {
    media.receive(audio(0))
    vi.advanceTimersByTime(160)
    event({ playout: .02 })
    expect(codec.decode).not.toHaveBeenCalled()
    expect(node.port.postMessage).toHaveBeenCalledWith({ played: true })
    event({ playout: .16 })
    expect(codec.decode).toHaveBeenCalledOnce()
  })
})

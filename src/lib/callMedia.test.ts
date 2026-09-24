import { afterEach, describe, expect, it, vi } from 'vitest'
import { CallAdaptation } from './callAdaptation'
import { callEncoding, callVideoFramerate, callVideoSize, normalizeCallQuality } from './callQuality'
import { BrowserCallMedia, type CallMediaCallbacks } from './callMedia'
vi.mock('./callOpus', () => ({ CallOpus: { open: async () => ({ close: vi.fn() }) } }))
const feedback = (feedback_seq: number, video_seq: number, received_frames: number) => ({ v: 3 as const, type: 'feedback' as const, call_id: 'ab'.repeat(16), feedback_seq, video_seq, received_frames, received_bytes: 10000, interval_ms: 1000 })
afterEach(() => vi.unstubAllGlobals())
describe('compressed call media', () => {
  it('uses delivered throughput to back off, holds to drain queues, then probes up to its cap', () => {
    const a = new CallAdaptation(2_000_000, 0)
    a.feedback({ ...feedback(0, 29, 20), received_bytes: 50000 }, 1000)
    expect(a.target).toBe(340000) // 85% of 400 kbps of complete video
    a.feedback(feedback(0, 29, 20), 2000)
    expect(a.target).toBe(340000)
    for (let seq = 1; seq < 5; seq++) a.feedback(feedback(seq, 29 + seq * 30, 30), (seq + 1) * 1000)
    expect(a.target).toBe(340000)
    a.feedback(feedback(5, 179, 30), 6000)
    expect(a.target).toBeGreaterThan(340000)
    a.setCap(350000)
    for (let seq = 6; seq < 12; seq++) a.feedback(feedback(seq, 29 + seq * 30, 30), (seq + 1) * 1000)
    expect(a.target).toBe(350000)
    a.tick(16000); expect(a.target).toBe(262500)
    a.tick(17100); expect(a.target).toBe(196875)
  })
  it('backs off during total video loss while controls survive, but does not probe idle capture', () => {
    const a = new CallAdaptation(2000000, 0)
    for (let seq = 0; seq < 5; seq++) {
      a.sentFrame()
      a.feedback({ ...feedback(seq, 0, 0), video_seq: undefined, received_bytes: 0 }, (seq + 1) * 1000)
    }
    expect(a.target).toBe(100000)
    a.feedback({ ...feedback(5, 0, 0), video_seq: undefined, received_bytes: 0 }, 6000)
    expect(a.target).toBe(100000)
    for (let seq = 6; seq < 36; seq++) a.feedback(feedback(seq, (seq - 5) * 30 - 1, 30), (seq + 1) * 1000)
    expect(a.target).toBeGreaterThan(500000)
  })
  it('does not treat a frame crossing report boundaries as permanent loss', () => {
    const a = new CallAdaptation(2000000, 0)
    for (let seq = 0; seq < 20; seq++) {
      a.feedback(feedback(seq, 29 + seq * 30, seq === 0 ? 29 : 30), (seq + 1) * 1000)
    }
    expect(a.target).toBe(2000000)
  })
  it('rejects invalid or regressing reports without consuming their sequence number', () => {
    for (const invalid of [
      { video_seq: 28 }, { video_seq: -1 }, { video_seq: 0x100000000 },
      { received_frames: 301 }, { received_bytes: 10000001 },
      { interval_ms: 199 }, { interval_ms: 5001 }, { interval_ms: NaN }, { received_frames: 1.5 },
    ]) {
      const a = new CallAdaptation(2000000, 0)
      a.feedback(feedback(0, 29, 30), 1000)
      const before = a.target
      a.feedback({ ...feedback(1, 59, 10), ...invalid }, 2000)
      expect(a.target).toBe(before)
      a.feedback(feedback(1, 59, 10), 2000)
      expect(a.target).toBeLessThan(before)
    }
  })
  it('accepts feedback and video sequence wraparound', () => {
    const a = new CallAdaptation(350000, 0)
    a.feedback(feedback(0xfffffffe, 0x7ffffffe, 30), 1000)
    a.feedback(feedback(0xffffffff, 0xfffffffd, 30), 2000)
    a.feedback(feedback(0, 27, 30), 3000)
    const before = a.target
    for (let seq = 1; seq <= 8; seq++) a.feedback(feedback(seq, 27 + seq * 30, 30), 3000 + seq * 1000)
    expect(a.target).toBeGreaterThan(before)
    expect(a.target).toBeLessThanOrEqual(350000)
  })
  it('reduces resolution and frame rate without upscaling or losing portrait orientation', () => {
    expect(callVideoSize({}, { width: 1080, height: 1920 }, 100000)).toEqual({ width: 144, height: 256 })
    expect(callVideoSize({}, { width: 1280, height: 720 }, 350000)).toEqual({ width: 480, height: 270 })
    expect(callVideoSize({}, { width: 640, height: 480 }, 800000)).toEqual({ width: 640, height: 480 })
    expect(callVideoFramerate({}, 100000)).toBe(10)
    expect(callVideoFramerate({}, 350000)).toBe(15)
    expect(callVideoFramerate({}, 1000000)).toBe(30)
  })
  it('uses configured resolution and bounded bitrate preferences', () => {
    expect(normalizeCallQuality({ quality: 'bogus', customBitrateKbps: NaN })).toEqual({ quality: 'auto', customBitrateKbps: 2000 })
    expect(callVideoSize({ quality: 'auto' }, { width: 1080, height: 1920 })).toEqual({ width: 720, height: 1280 })
    expect(callVideoSize({ quality: 'high' }, { width: 640, height: 480 })).toEqual({ width: 640, height: 480 })
    expect(callEncoding({ quality: 'auto' })).toMatchObject({ width: 1280, height: 720, maxBitrate: 2000000 })
    expect(callEncoding({ quality: 'high' })).toMatchObject({ width: 1920, height: 1080, codec: 'avc1.42e028' })
    expect(callEncoding({ quality: 'custom', customBitrateKbps: -1 }).maxBitrate).toBe(100000)
    expect(callEncoding({ quality: 'custom', customBitrateKbps: 1e10 }).maxBitrate).toBe(8000000)
  })
  it('stops a late capture result after the call has ended', async () => {
    let finish!: (value: unknown) => void
    const stop = vi.fn()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise(resolve => { finish = resolve }) } })
    vi.stubGlobal('AudioWorkletNode', class {})
    const media = new BrowserCallMedia({} as CallMediaCallbacks)
    const opening = media.open(false)
    await vi.waitFor(() => expect(finish).toBeDefined())
    media.stop()
    finish({ getTracks: () => [{ stop }] })
    await expect(opening).rejects.toThrow('Call ended')
    expect(stop).toHaveBeenCalledOnce()
  })
  it('checks real video encoder capability before opening the microphone', async () => {
    const capture = vi.fn()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: capture } })
    vi.stubGlobal('AudioWorkletNode', class {})
    vi.stubGlobal('VideoEncoder', class { static isConfigSupported = async () => ({ supported: false }) })
    vi.stubGlobal('VideoDecoder', class {})
    await expect(new BrowserCallMedia({} as CallMediaCallbacks).open(true)).rejects.toThrow('Update your browser')
    expect(capture).not.toHaveBeenCalled()
  })
})

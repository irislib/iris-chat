import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BrowserCallMedia, type CallMediaCallbacks } from './callMedia'

vi.mock('./callOpus', () => ({ CallOpus: { open: async () => ({ close: vi.fn() }) } }))
class Track extends EventTarget {
  enabled = false
  readyState = 'live'
  constructor(readonly kind: string) { super() }
  getSettings() { return { width: 1280, height: 720 } }
  stop = vi.fn(() => { this.readyState = 'ended' })
  applyConstraints = vi.fn(async () => {})
}
class Stream {
  constructor(readonly tracks: Track[]) {}
  getTracks() { return this.tracks }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio') }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video') }
  removeTrack(track: Track) { this.tracks.splice(this.tracks.indexOf(track), 1) }
  addTrack(track: Track) { this.tracks.push(track) }
}
let encoders: Encoder[]
let failConfiguration: boolean
class Encoder {
  static isConfigSupported = async () => ({ supported: true })
  state = 'unconfigured'
  encodeQueueSize = 0
  constructor(readonly callbacks: VideoEncoderInit) { encoders.push(this) }
  configure() { if (failConfiguration) { failConfiguration = false; throw new Error('Encoder unavailable') }; this.state = 'configured' }
  close = vi.fn(() => { this.state = 'closed' })
  encode = vi.fn()
  emit() { this.callbacks.output({ timestamp: 0, byteLength: 5, type: 'key', copyTo() {} } as unknown as EncodedVideoChunk, {}) }
}
let media: BrowserCallMedia
let camera: Track, mic: Track, screen: Track
let base: Stream, selected: Stream
let callbacks: CallMediaCallbacks
let getDisplayMedia: ReturnType<typeof vi.fn>, getUserMedia: ReturnType<typeof vi.fn>, audioClose: ReturnType<typeof vi.fn>
let contextCount: number
beforeEach(async () => {
  vi.useFakeTimers(); encoders = []; failConfiguration = false; contextCount = 0
  camera = new Track('video'); mic = new Track('audio'); screen = new Track('video')
  base = new Stream([mic, camera]); selected = new Stream([screen])
  getUserMedia = vi.fn(async () => base)
  getDisplayMedia = vi.fn(async () => selected)
  audioClose = vi.fn(async () => {})
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, getDisplayMedia, addEventListener() {}, removeEventListener() {} } })
  vi.stubGlobal('AudioContext', class {
    audioWorklet = { addModule: async () => {} }
    constructor() { contextCount++ }
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
    resume = async () => {}
    close = audioClose
  })
  vi.stubGlobal('AudioWorkletNode', class { port = { postMessage: vi.fn() }; connect() {}; disconnect() {} })
  vi.stubGlobal('VideoEncoder', Encoder)
  vi.stubGlobal('VideoDecoder', class {
    static isConfigSupported = async () => ({ supported: true })
    state = 'configured'; configure() {}; close() { this.state = 'closed' }
  })
  vi.stubGlobal('document', { createElement: () => ({ play: async () => {}, pause() {}, readyState: 0 }) })
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:audio', revokeObjectURL() {} })
  callbacks = { send: vi.fn(async () => {}), feedback: vi.fn(), highestVideo: () => undefined, remoteVideo: vi.fn(), requestKeyframe: vi.fn(), error: vi.fn(), streamChanged: vi.fn(), screenSharing: vi.fn(), screenError: vi.fn() }
  media = new BrowserCallMedia(callbacks)
  await media.open(true)
  media.setState(true, false, true, true)
})
afterEach(() => { media.stop(); vi.useRealTimers(); vi.unstubAllGlobals() })

it.each([true, false])('restores the prior camera state (%s) without reopening audio or transport', async (cameraOn: boolean) => {
  media.setState(true, true, cameraOn, true)
  expect(getDisplayMedia).not.toHaveBeenCalled()
  await expect(media.startScreenSharing()).resolves.toBe(true)
  expect(getDisplayMedia).toHaveBeenCalledWith({ video: { frameRate: { ideal: 15, max: 15 } }, audio: false })
  expect(camera.enabled).toBe(false)
  expect(mic.enabled).toBe(false)
  expect(callbacks.streamChanged).toHaveBeenLastCalledWith(selected)
  expect(callbacks.screenSharing).toHaveBeenLastCalledWith(true, true)
  media.setState(true, false, true, true) // Unmute while sharing must not enable the camera.
  expect(camera.enabled).toBe(false)
  expect(mic.enabled).toBe(true)
  media.stopScreenSharing()
  expect(screen.stop).toHaveBeenCalledOnce()
  expect(camera.enabled).toBe(cameraOn)
  expect(callbacks.screenSharing).toHaveBeenLastCalledWith(false, cameraOn)
  expect(callbacks.streamChanged).toHaveBeenLastCalledWith(base)
  expect(contextCount).toBe(1)
  expect(audioClose).not.toHaveBeenCalled()
  expect(mic.stop).not.toHaveBeenCalled()
  expect(getUserMedia).toHaveBeenCalledOnce()
})
it.each(['NotAllowedError', 'AbortError'])('leaves the call unchanged when picker returns %s', async (name: string) => {
  getDisplayMedia.mockRejectedValueOnce(new DOMException('Cancelled', name))
  await expect(media.startScreenSharing()).resolves.toBe(false)
  expect(camera.enabled).toBe(true)
  expect(encoders).toHaveLength(1)
  expect(callbacks.screenSharing).not.toHaveBeenCalled()
  expect(audioClose).not.toHaveBeenCalled()
  await expect(media.startScreenSharing()).resolves.toBe(true)
})
it('releases late permission results after the call ends and cannot restart capture', async () => {
  let resolve!: (stream: Stream) => void
  getDisplayMedia.mockImplementationOnce(() => new Promise(r => { resolve = r }))
  const pending = media.startScreenSharing()
  await expect(media.startScreenSharing()).resolves.toBe(false)
  media.stop()
  resolve(selected)
  await expect(pending).resolves.toBe(false)
  expect(screen.stop).toHaveBeenCalledOnce()
  expect(callbacks.screenSharing).not.toHaveBeenCalled()
  expect(encoders).toHaveLength(1)
})
it('browser stop restores camera-off and a stale ended event cannot stop the next share', async () => {
  media.setState(true, false, false, true)
  await media.startScreenSharing()
  screen.dispatchEvent(new Event('ended'))
  expect(callbacks.screenSharing).toHaveBeenLastCalledWith(false, false)
  expect(camera.enabled).toBe(false)
  const replacement = new Track('video')
  getDisplayMedia.mockResolvedValueOnce(new Stream([replacement]))
  await media.startScreenSharing()
  screen.dispatchEvent(new Event('ended'))
  expect(callbacks.screenSharing).toHaveBeenLastCalledWith(true, true)
  expect(replacement.stop).not.toHaveBeenCalled()
})
it('invalidates queued encoder output and in-flight source sends across screen/camera switches', async () => {
  const cameraEncoder = encoders[0]
  await media.startScreenSharing()
  cameraEncoder.emit()
  expect(callbacks.send).not.toHaveBeenCalled()
  const screenEncoder = encoders[1]
  screenEncoder.emit()
  const allowed = vi.mocked(callbacks.send).mock.calls[0][1]!
  expect(allowed()).toBe(true)
  media.stopScreenSharing()
  expect(allowed()).toBe(false)
  screenEncoder.emit(); cameraEncoder.emit()
  expect(callbacks.send).toHaveBeenCalledOnce()
  encoders[2].emit()
  expect(callbacks.send).toHaveBeenCalledTimes(2)
})
it('keeps camera and audio running when the selected source cannot be encoded', async () => {
  failConfiguration = true
  await expect(media.startScreenSharing()).rejects.toThrow('Encoder unavailable')
  expect(screen.stop).toHaveBeenCalledOnce()
  expect(encoders[0].close).not.toHaveBeenCalled()
  expect(camera.enabled).toBe(true)
  expect(callbacks.error).not.toHaveBeenCalled()
  expect(audioClose).not.toHaveBeenCalled()
})
it('handles a screen encoder failure without ending the audio call', async () => {
  await media.startScreenSharing()
  encoders[1].callbacks.error(new DOMException('Encoder lost'))
  expect(callbacks.screenSharing).toHaveBeenLastCalledWith(false, true)
  expect(callbacks.screenError).toHaveBeenCalledOnce()
  expect(callbacks.error).not.toHaveBeenCalled()
  expect(audioClose).not.toHaveBeenCalled()
  expect(mic.enabled).toBe(true)
})
it('does not request sharing for a voice-only or inactive call', async () => {
  media.setState(true, false, false, false)
  await expect(media.startScreenSharing()).resolves.toBe(false)
  media.setState(false, false, true, true)
  await expect(media.startScreenSharing()).resolves.toBe(false)
  expect(getDisplayMedia).not.toHaveBeenCalled()
})
it('stops active display tracks on call teardown without restoring the camera', async () => {
  await media.startScreenSharing()
  vi.mocked(callbacks.screenSharing).mockClear()
  media.stop()
  expect(screen.stop).toHaveBeenCalledOnce()
  expect(camera.stop).toHaveBeenCalledOnce()
  expect(callbacks.screenSharing).not.toHaveBeenCalled()
})

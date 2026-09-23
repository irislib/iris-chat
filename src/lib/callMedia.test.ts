import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserCallMedia } from './callMedia'

describe('camera capture cleanup', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
  it('does not send a JPEG whose encoding completes after the call ends', async () => {
    vi.useFakeTimers()
    const stop = vi.fn(), track = { stop, enabled: true }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [track] }
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream) } })
    const connection = { connect: vi.fn(), disconnect: vi.fn() }
    vi.stubGlobal('AudioContext', class {
      destination = {}
      resume = vi.fn(async () => {})
      close = vi.fn(async () => {})
      createMediaStreamSource = () => connection
      createScriptProcessor = () => ({ ...connection, onaudioprocess: null })
    })
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
    let finish!: (value: ArrayBuffer) => void
    const encoded = new Promise<ArrayBuffer>(resolve => { finish = resolve })
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback: BlobCallback) => callback({ arrayBuffer: () => encoded } as Blob))
    const send = vi.fn(async () => {})
    const media = new BrowserCallMedia(send, vi.fn())
    await media.open(true)
    media.setState(true, false, true, true)
    vi.advanceTimersByTime(125)
    media.stop()
    finish(new Uint8Array([255, 216, 255, 217]).buffer)
    await Promise.resolve(); await Promise.resolve()
    expect(send).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalled()
  })
})

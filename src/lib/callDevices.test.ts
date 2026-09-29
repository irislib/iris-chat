import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserCallMedia, type CallMediaCallbacks } from './callMedia'
import type { CallDeviceState } from './callDevices'

vi.mock('./callOpus', () => ({ CallOpus: { open: async () => ({ close: vi.fn() }) } }))
class Track {
  enabled = false
  readyState = 'live'
  constructor(readonly id: string) {}
  stop = vi.fn(() => { this.readyState = 'ended' })
}
class Stream {
  constructor(readonly tracks: Track[]) {}
  getTracks() { return this.tracks }
  getAudioTracks() { return this.tracks }
  getVideoTracks() { return [] }
  removeTrack(track: Track) { this.tracks.splice(this.tracks.indexOf(track), 1) }
  addTrack(track: Track) { this.tracks.push(track) }
}
let media: BrowserCallMedia
let initial: Track
let devices: Array<{ deviceId: string; kind: string; label: string }>
let states: CallDeviceState[]
let getUserMedia: ReturnType<typeof vi.fn>
let enumerateDevices: ReturnType<typeof vi.fn>
let setSinkId: ReturnType<typeof vi.fn>
let contextCount: number
let callbacks: CallMediaCallbacks
let sources: Array<{ connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }>
const latest = () => states.at(-1)!
beforeEach(async () => {
  vi.useFakeTimers()
  initial = new Track('first')
  states = []; sources = []; contextCount = 0
  devices = [
    { deviceId: 'first', kind: 'audioinput', label: 'Built-in microphone' },
    { deviceId: 'usb', kind: 'audioinput', label: 'USB microphone' },
    { deviceId: 'headphones', kind: 'audiooutput', label: 'Headphones' },
  ]
  getUserMedia = vi.fn(async () => new Stream([initial]))
  enumerateDevices = vi.fn(async () => devices)
  setSinkId = vi.fn(async () => {})
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices, addEventListener: vi.fn(), removeEventListener: vi.fn() } })
  vi.stubGlobal('AudioContext', class {
    audioWorklet = { addModule: async () => {} }
    setSinkId = setSinkId
    constructor() { contextCount++ }
    createMediaStreamSource() {
      const source = { connect: vi.fn(), disconnect: vi.fn() }; sources.push(source); return source
    }
    resume = async () => {}
    close = vi.fn(async () => {})
  })
  vi.stubGlobal('AudioWorkletNode', class {
    port = { postMessage: vi.fn() }
    connect() {}
    disconnect() {}
  })
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:audio', revokeObjectURL() {} })
  callbacks = { send: vi.fn(), feedback: vi.fn(), highestVideo: () => undefined, remoteVideo: vi.fn(), requestKeyframe: vi.fn(), devices: value => states.push(value), deviceError: vi.fn(), streamChanged: vi.fn() }
  media = new BrowserCallMedia(callbacks)
  await media.open(false)
  media.setState(true, false, false, false)
})
afterEach(() => { media.stop(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('changing call audio devices', () => {
  it('replaces capture without restarting playback or the call and keeps mute', async () => {
    const next = new Track('usb')
    getUserMedia.mockResolvedValueOnce(new Stream([next]))
    media.setState(true, true, false, false)
    await media.selectDevice('microphone', 'usb')
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: expect.objectContaining({ deviceId: { exact: 'usb' }, echoCancellation: true }), video: false })
    expect(initial.stop).toHaveBeenCalledOnce()
    expect(next.enabled).toBe(false)
    expect(sources[0].disconnect).toHaveBeenCalledOnce()
    expect(sources[1].connect).toHaveBeenCalledOnce()
    expect(contextCount).toBe(1)
    expect(latest().microphone).toBe('usb')
    media.setState(true, false, false, false)
    expect(next.enabled).toBe(true)
  })
  it('keeps the old microphone on permission or connection failure', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'))
    await expect(media.selectDevice('microphone', 'usb')).rejects.toThrow('Denied')
    expect(initial.stop).not.toHaveBeenCalled()
    expect(initial.enabled).toBe(true)
    expect(latest().microphone).toBe('')
  })
  it('releases a newly granted microphone if the call ended while permission was pending', async () => {
    const next = new Track('usb')
    let grant!: (stream: Stream) => void
    getUserMedia.mockImplementationOnce(() => new Promise(resolve => { grant = resolve }))
    const pending = media.selectDevice('microphone', 'usb')
    media.stop()
    grant(new Stream([next]))
    await pending
    expect(next.stop).toHaveBeenCalledOnce()
    expect(callbacks.streamChanged).not.toHaveBeenCalled()
    expect(media.stream).toBeNull()
  })
  it('keeps the current speaker after a failed switch', async () => {
    await media.selectDevice('speaker', 'headphones')
    setSinkId.mockRejectedValueOnce(new Error('Output unavailable'))
    await expect(media.selectDevice('speaker', '')).rejects.toThrow('Output unavailable')
    expect(latest().speaker).toBe('headphones')
    expect(contextCount).toBe(1)
  })
  it('returns to system defaults after the selected headset is removed', async () => {
    const usb = new Track('usb'), fallback = new Track('first')
    getUserMedia.mockResolvedValueOnce(new Stream([usb]))
    await media.selectDevice('microphone', 'usb')
    await media.selectDevice('speaker', 'headphones')
    usb.readyState = 'ended'
    devices = devices.filter(device => !['usb', 'headphones'].includes(device.deviceId))
    getUserMedia.mockResolvedValueOnce(new Stream([fallback]))
    await media.refreshDevices()
    expect(latest()).toMatchObject({ microphone: '', speaker: '' })
    expect(fallback.enabled).toBe(true)
    expect(setSinkId).toHaveBeenLastCalledWith('')
    expect(contextCount).toBe(1)
  })
  it.each(['microphone', 'speaker'] as const)('reports a successful %s switch even if refreshing the list fails', async (kind: 'microphone' | 'speaker') => {
    const id = kind === 'microphone' ? 'usb' : 'headphones'
    getUserMedia.mockResolvedValueOnce(new Stream([new Track(id)]))
    enumerateDevices.mockRejectedValueOnce(new Error('Enumeration failed'))
    await expect(media.selectDevice(kind, id)).resolves.toBeUndefined()
    expect(latest()[kind]).toBe(id)
    expect(callbacks.deviceError).toHaveBeenCalledWith('Could not refresh audio devices')
  })
  it('ignores an older device list after hotplug and a manual switch', async () => {
    let resolveOld!: (value: typeof devices) => void
    const oldDevices = devices.filter(device => device.deviceId !== 'usb')
    enumerateDevices.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    const oldRefresh = media.refreshDevices()
    await media.refreshDevices()
    const usb = new Track('usb')
    getUserMedia.mockResolvedValueOnce(new Stream([usb]))
    await media.selectDevice('microphone', 'usb')
    resolveOld(oldDevices)
    await oldRefresh
    expect(latest().microphone).toBe('usb')
    expect(latest().microphones.map(device => device.id)).toContain('usb')
    expect(usb.stop).not.toHaveBeenCalled()
    expect(getUserMedia).toHaveBeenCalledTimes(2)
  })
  it('does not undo a pending manual switch with an older enumeration', async () => {
    let resolveOld!: (value: typeof devices) => void
    enumerateDevices.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    const oldRefresh = media.refreshDevices()
    let grant!: (stream: Stream) => void
    getUserMedia.mockImplementationOnce(() => new Promise(resolve => { grant = resolve }))
    const switching = media.selectDevice('microphone', 'usb')
    const count = states.length
    resolveOld([])
    await oldRefresh
    expect(states).toHaveLength(count)
    grant(new Stream([new Track('usb')]))
    await switching
    expect(latest().microphone).toBe('usb')
  })
  it('does not fail a call when the device list is temporarily unavailable', async () => {
    enumerateDevices.mockRejectedValueOnce(new Error('Enumeration failed'))
    await expect(media.open(false)).resolves.toBeUndefined()
    expect(callbacks.deviceError).toHaveBeenCalledWith('Could not list audio devices')
    expect(media.stream).not.toBeNull()
  })
})

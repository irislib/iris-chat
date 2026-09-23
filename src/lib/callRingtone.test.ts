import { afterEach, expect, it, vi } from 'vitest'
import { CallRingtone } from './callRingtone'
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
it('rings at most 30 seconds and closes audio immediately when stopped', () => {
  vi.useFakeTimers()
  const close = vi.fn(async () => {}), stop = vi.fn(), start = vi.fn()
  vi.stubGlobal('AudioContext', class {
    state = 'running'; currentTime = 0; destination = {}; close = close
    createGain = () => ({ connect() {}, gain: { setValueAtTime() {}, linearRampToValueAtTime() {} } })
    createOscillator = () => ({ frequency: { value: 0 }, connect() {}, start, stop })
  })
  const ringtone = new CallRingtone()
  ringtone.start(); ringtone.start()
  expect(start).toHaveBeenCalledTimes(2)
  expect(stop).toHaveBeenCalledWith(30)
  ringtone.stop()
  expect(close).toHaveBeenCalledTimes(1)
  ringtone.start(); vi.advanceTimersByTime(30000)
  expect(close).toHaveBeenCalledTimes(2)
})
it('respects browser autoplay restrictions instead of forcing playback', () => {
  const close = vi.fn(async () => {}), createGain = vi.fn()
  vi.stubGlobal('AudioContext', class { state = 'suspended'; close = close; createGain = createGain })
  new CallRingtone().start()
  expect(close).toHaveBeenCalled()
  expect(createGain).not.toHaveBeenCalled()
})

import { afterEach, expect, it, vi } from 'vitest'
import { CallRingtone } from './callRingtone'
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
function audio(state = 'running') {
  const close = vi.fn(async () => {}), stop = vi.fn(), start = vi.fn(), disconnect = vi.fn()
  const context = { state, currentTime: 0, destination: {}, close,
    resume: vi.fn(async () => { context.state = 'running' }),
    createGain: vi.fn(() => ({ connect() {}, disconnect, gain: { setValueAtTime() {}, linearRampToValueAtTime() {} } })),
    createOscillator: () => ({ frequency: { value: 0 }, connect() {}, disconnect, start, stop }) }
  vi.stubGlobal('AudioContext', class { constructor() { return context } })
  return { context, close, start, stop, disconnect }
}
it('bounds each ring and stops sound immediately while preserving gesture-unlocked audio', () => {
  vi.useFakeTimers()
  const a = audio(), ring = new CallRingtone()
  ring.start(); ring.start()
  expect(a.start).toHaveBeenCalledTimes(2)
  ring.stop()
  expect(a.disconnect).toHaveBeenCalledTimes(3)
  expect(a.close).not.toHaveBeenCalled()
  ring.start(); vi.advanceTimersByTime(30000)
  expect(a.disconnect).toHaveBeenCalledTimes(6)
  ring.dispose(); expect(a.close).toHaveBeenCalledOnce()
})
it('unlocks suspended audio with a gesture and never resumes a canceled ring', async () => {
  vi.useFakeTimers()
  const a = audio('suspended'), ring = new CallRingtone()
  ring.start(); expect(a.start).not.toHaveBeenCalled()
  ring.unlock(); ring.stop(); await Promise.resolve()
  expect(a.start).not.toHaveBeenCalled()
  ring.start(); expect(a.start).toHaveBeenCalledTimes(2)
  ring.dispose()
})

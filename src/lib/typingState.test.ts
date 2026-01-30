import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { get } from 'svelte/store'

describe('typingState', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should start with empty map', async () => {
    const { isTyping } = await import('./typingState')
    expect(get(isTyping).size).toBe(0)
  })

  it('setRemoteTyping marks chat as typing', async () => {
    const { isTyping, setRemoteTyping } = await import('./typingState')
    setRemoteTyping('chat1')
    expect(get(isTyping).get('chat1')).toBe(true)
  })

  it('auto-expires after TYPING_EXPIRY_MS', async () => {
    const { isTyping, setRemoteTyping, TYPING_EXPIRY_MS } = await import('./typingState')
    setRemoteTyping('chat1')
    expect(get(isTyping).get('chat1')).toBe(true)
    vi.advanceTimersByTime(TYPING_EXPIRY_MS)
    expect(get(isTyping).get('chat1')).toBeUndefined()
  })

  it('resets expiry timer on subsequent events', async () => {
    const { isTyping, setRemoteTyping, TYPING_EXPIRY_MS } = await import('./typingState')
    setRemoteTyping('chat1')
    const half = TYPING_EXPIRY_MS / 2
    vi.advanceTimersByTime(half)
    setRemoteTyping('chat1')
    vi.advanceTimersByTime(half)
    // Should still be typing (only half since last event)
    expect(get(isTyping).get('chat1')).toBe(true)
    vi.advanceTimersByTime(half)
    // Now full expiry since last event
    expect(get(isTyping).get('chat1')).toBeUndefined()
  })

  it('clearRemoteTyping clears state', async () => {
    const { isTyping, setRemoteTyping, clearRemoteTyping } = await import('./typingState')
    setRemoteTyping('chat1')
    expect(get(isTyping).get('chat1')).toBe(true)
    clearRemoteTyping('chat1')
    expect(get(isTyping).get('chat1')).toBeUndefined()
  })

  it('tracks multiple chats independently', async () => {
    const { isTyping, setRemoteTyping, TYPING_EXPIRY_MS } = await import('./typingState')
    setRemoteTyping('chat1')
    setRemoteTyping('chat2')
    expect(get(isTyping).get('chat1')).toBe(true)
    expect(get(isTyping).get('chat2')).toBe(true)
    vi.advanceTimersByTime(TYPING_EXPIRY_MS)
    expect(get(isTyping).get('chat1')).toBeUndefined()
    expect(get(isTyping).get('chat2')).toBeUndefined()
  })

  it('createTypingThrottle fires immediately first time', async () => {
    const { createTypingThrottle } = await import('./typingState')
    const fn = vi.fn()
    const throttled = createTypingThrottle(fn, 3000)
    throttled()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('createTypingThrottle suppresses within throttle window', async () => {
    const { createTypingThrottle } = await import('./typingState')
    const fn = vi.fn()
    const throttled = createTypingThrottle(fn, 3000)
    throttled()
    throttled()
    throttled()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('createTypingThrottle fires again after throttle period', async () => {
    const { createTypingThrottle } = await import('./typingState')
    const fn = vi.fn()
    const throttled = createTypingThrottle(fn, 3000)
    throttled()
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(3000)
    throttled()
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

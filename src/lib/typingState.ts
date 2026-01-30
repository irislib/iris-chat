import { writable } from 'svelte/store'

export const TYPING_EXPIRY_MS = 10000

export const isTyping = writable<Map<string, boolean>>(new Map())

const timers = new Map<string, ReturnType<typeof setTimeout>>()

export function setRemoteTyping(chatId: string): void {
  // Clear existing timer
  const existing = timers.get(chatId)
  if (existing) clearTimeout(existing)

  // Set typing state
  isTyping.update(m => {
    const next = new Map(m)
    next.set(chatId, true)
    return next
  })

  timers.set(chatId, setTimeout(() => {
    timers.delete(chatId)
    isTyping.update(m => {
      const next = new Map(m)
      next.delete(chatId)
      return next
    })
  }, TYPING_EXPIRY_MS))
}

export function clearRemoteTyping(chatId: string): void {
  const existing = timers.get(chatId)
  if (existing) {
    clearTimeout(existing)
    timers.delete(chatId)
  }
  isTyping.update(m => {
    const next = new Map(m)
    next.delete(chatId)
    return next
  })
}

export function createTypingThrottle(callback: () => void, intervalMs: number): () => void {
  let lastFired = 0
  return () => {
    const now = Date.now()
    if (now - lastFired >= intervalMs) {
      lastFired = now
      callback()
    }
  }
}

import { writable } from 'svelte/store'

export const TYPING_EXPIRY_MS = 10000

export const isTyping = writable<Map<string, boolean>>(new Map())

const timers = new Map<string, ReturnType<typeof setTimeout>>()
const lastMessageAt = new Map<string, number>()

export function setRemoteTyping(chatId: string, eventTimestamp?: number): void {
  // Ignore typing events older than the last received message
  if (eventTimestamp) {
    const lastMsg = lastMessageAt.get(chatId)
    if (lastMsg && eventTimestamp <= lastMsg) return
  }
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

export function clearRemoteTyping(chatId: string, messageTimestamp?: number): void {
  if (messageTimestamp) {
    const existing = lastMessageAt.get(chatId) || 0
    lastMessageAt.set(chatId, Math.max(existing, messageTimestamp))
  }
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

export function createTypingThrottle(callback: () => void, intervalMs: number): { fire: () => void, reset: () => void } {
  let lastFired = 0
  return {
    fire() {
      const now = Date.now()
      if (now - lastFired >= intervalMs) {
        lastFired = now
        callback()
      }
    },
    reset() {
      lastFired = 0
    },
  }
}

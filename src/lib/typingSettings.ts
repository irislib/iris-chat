import { writable } from 'svelte/store'

export interface TypingSettings {
  sendTypingIndicators: boolean
}

const STORAGE_KEY = 'iris-chat-typing'

function loadSettings(): TypingSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      return JSON.parse(stored)
    }
  } catch {}
  return { sendTypingIndicators: true }
}

function save(settings: TypingSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export const typingSettings = writable<TypingSettings>(loadSettings())

export function setSendTypingIndicators(value: boolean): void {
  typingSettings.update(s => {
    const updated = { ...s, sendTypingIndicators: value }
    save(updated)
    return updated
  })
}

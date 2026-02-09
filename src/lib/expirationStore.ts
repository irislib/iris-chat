import { writable } from 'svelte/store'

export type ChatExpirationSeconds = number | null

interface ChatExpirationState {
  expirations: Record<string, ChatExpirationSeconds | undefined>
}

const STORAGE_KEY = 'iris-chat-expirations'

function loadFromStorage(): ChatExpirationState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed.expirations) {
        return { expirations: parsed.expirations }
      }
    }
  } catch {
    // ignore
  }
  return { expirations: {} }
}

function saveToStorage(state: ChatExpirationState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // ignore
  }
}

const initial = loadFromStorage()
const { subscribe, update } = writable<ChatExpirationState>(initial)

function setExpiration(chatId: string, ttlSeconds: ChatExpirationSeconds | undefined): void {
  update((state) => {
    const next = { expirations: { ...state.expirations, [chatId]: ttlSeconds } }
    saveToStorage(next)
    return next
  })
}

function clearExpiration(chatId: string): void {
  update((state) => {
    const next = { ...state.expirations }
    delete next[chatId]
    const result = { expirations: next }
    saveToStorage(result)
    return result
  })
}

function getExpiration(chatId: string): ChatExpirationSeconds | undefined {
  let result: ChatExpirationSeconds | undefined
  subscribe((state) => {
    result = state.expirations[chatId]
  })()
  return result
}

function getAllExpirations(): Record<string, ChatExpirationSeconds | undefined> {
  let result: Record<string, ChatExpirationSeconds | undefined> = {}
  subscribe((state) => {
    result = state.expirations
  })()
  return result
}

export const expirationStore = {
  subscribe,
  setExpiration,
  clearExpiration,
  getExpiration,
  getAllExpirations,
}

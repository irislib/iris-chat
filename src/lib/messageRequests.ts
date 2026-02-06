import { writable } from 'svelte/store'

type ChatFlagMap = Record<string, true | undefined>

export interface MessageRequestDecisions {
  acceptedChats: ChatFlagMap
  rejectedChats: ChatFlagMap
}

const STORAGE_KEY = 'iris-chat-message-request-decisions'

function loadFromStorage(): MessageRequestDecisions {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<MessageRequestDecisions> | null
      if (parsed && typeof parsed === 'object') {
        return {
          acceptedChats: (parsed.acceptedChats as ChatFlagMap) || {},
          rejectedChats: (parsed.rejectedChats as ChatFlagMap) || {},
        }
      }
    }
  } catch {
    // ignore parse errors
  }
  return { acceptedChats: {}, rejectedChats: {} }
}

function saveToStorage(state: MessageRequestDecisions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // ignore storage errors
  }
}

export const messageRequests = writable<MessageRequestDecisions>(loadFromStorage())

export function acceptChat(chatId: string): void {
  messageRequests.update((state) => {
    const acceptedChats: ChatFlagMap = { ...state.acceptedChats, [chatId]: true }
    const rejectedChats: ChatFlagMap = { ...state.rejectedChats }
    delete rejectedChats[chatId]
    const updated = { acceptedChats, rejectedChats }
    saveToStorage(updated)
    return updated
  })
}

export function rejectChat(chatId: string): void {
  messageRequests.update((state) => {
    const rejectedChats: ChatFlagMap = { ...state.rejectedChats, [chatId]: true }
    const acceptedChats: ChatFlagMap = { ...state.acceptedChats }
    delete acceptedChats[chatId]
    const updated = { acceptedChats, rejectedChats }
    saveToStorage(updated)
    return updated
  })
}

export function clearChat(chatId: string): void {
  messageRequests.update((state) => {
    const acceptedChats: ChatFlagMap = { ...state.acceptedChats }
    const rejectedChats: ChatFlagMap = { ...state.rejectedChats }
    delete acceptedChats[chatId]
    delete rejectedChats[chatId]
    const updated = { acceptedChats, rejectedChats }
    saveToStorage(updated)
    return updated
  })
}


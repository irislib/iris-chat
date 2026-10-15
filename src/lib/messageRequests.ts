import { deviceRecordVersion } from './deviceSyncRecordStore'
import { get, writable } from 'svelte/store'

type ChatFlagMap = Record<string, true | undefined>

export interface MessageRequestDecisions {
  acceptedChats: ChatFlagMap
  rejectedChats: ChatFlagMap
}

const STORAGE_KEY = 'iris-chat-message-request-decisions'
export interface RequestDecision { chatId: string; decision: 'accepted' | 'rejected' | 'none'; updatedAtMs: number }
let activeOwner: string | null = null
let versions: Record<string, RequestDecision> = {}
const stateKey = (owner: string) => `${STORAGE_KEY}:${owner}`
export function validRequestDecision(value: unknown): value is RequestDecision {
  if (!value || typeof value !== 'object') return false
  const v = value as RequestDecision
  return typeof v.chatId === 'string' && (/^[a-f0-9]{64}$/.test(v.chatId) || /^group:[^\x00-\x20]{1,128}$/.test(v.chatId)) &&
    ['accepted', 'rejected', 'none'].includes(v.decision) && Number.isSafeInteger(v.updatedAtMs) && v.updatedAtMs > 0 && v.updatedAtMs <= Date.now() + 300_000
}
const rank = (decision: RequestDecision['decision']) => ({ none: 0, accepted: 1, rejected: 2 })[decision]
const newer = (a: RequestDecision, b?: RequestDecision) => !b || a.updatedAtMs > b.updatedAtMs || a.updatedAtMs === b.updatedAtMs && rank(a.decision) > rank(b.decision)
function projection(): MessageRequestDecisions {
  return { acceptedChats: Object.fromEntries(Object.values(versions).filter(v => v.decision === 'accepted').map(v => [v.chatId, true])),
    rejectedChats: Object.fromEntries(Object.values(versions).filter(v => v.decision === 'rejected').map(v => [v.chatId, true])) }
}
export function loadMessageRequestDecisions(owner: string): void {
  if (activeOwner === owner) return
  const saved = localStorage.getItem(stateKey(owner))
  const next: Record<string, RequestDecision> = {}
  if (saved) {
    const values: unknown = JSON.parse(saved)
    if (!Array.isArray(values) || !values.every(validRequestDecision)) throw new Error('Invalid request decisions')
    for (const value of values) if (newer(value, next[value.chatId])) next[value.chatId] = value
  } else {
    const old = loadFromStorage()
    for (const chatId of new Set([...Object.keys(old.acceptedChats), ...Object.keys(old.rejectedChats)])) {
      const value: RequestDecision = { chatId, decision: old.rejectedChats[chatId] ? 'rejected' : 'accepted', updatedAtMs: 1 }
      if (validRequestDecision(value)) next[chatId] = value
    }
    localStorage.setItem(stateKey(owner), JSON.stringify(Object.values(next)))
  }
  activeOwner = owner
  versions = next
  messageRequests.set(projection())
  localStorage.removeItem(STORAGE_KEY)
}
export function requestDecisionStates(owner: string): RequestDecision[] {
  return activeOwner === owner ? Object.values(versions) : []
}
export function mergeRequestDecision(owner: string, value: RequestDecision): void {
  if (activeOwner !== owner || !validRequestDecision(value)) throw new Error('Invalid request decision or account')
  if (!newer(value, versions[value.chatId])) return
  const next = { ...versions, [value.chatId]: value }
  localStorage.setItem(stateKey(owner), JSON.stringify(Object.values(next)))
  versions = next
  messageRequests.set(projection())
  deviceRecordVersion.update(n => n + 1)
}


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
  if (!activeOwner) { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return }
  const current = get(messageRequests), next = { ...versions }
  for (const chatId of new Set([...Object.keys(state.acceptedChats), ...Object.keys(state.rejectedChats), ...Object.keys(current.acceptedChats), ...Object.keys(current.rejectedChats)])) {
    const decision = state.rejectedChats[chatId] ? 'rejected' : state.acceptedChats[chatId] ? 'accepted' : 'none'
    if (versions[chatId]?.decision === decision) continue
    const value: RequestDecision = { chatId, decision, updatedAtMs: Math.max(Date.now(), (versions[chatId]?.updatedAtMs ?? 0) + 1) }
    if (validRequestDecision(value)) next[chatId] = value
  }
  localStorage.setItem(stateKey(activeOwner), JSON.stringify(Object.values(next)))
  versions = next
  deviceRecordVersion.update(n => n + 1)
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

// Account decisions must not grant access to chats in the next local profile.
export function clearMessageRequestDecisions(): void {
  activeOwner = null
  versions = {}
  messageRequests.set({ acceptedChats: {}, rejectedChats: {} })
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* Storage may be unavailable. */ }
}

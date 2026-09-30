import { get, writable, derived } from 'svelte/store'
import { identity } from './identity'
import { getSessionManagerValue, putSessionManagerValue, deleteSessionManagerValue } from './storage'
import { isChatPinState, isNewerChatPin, type ChatPinState } from './chatPinSync'

export const chatPinStates = writable<Record<string, ChatPinState>>({})
export const pinnedChatIds = derived(chatPinStates, states => new Set(Object.values(states).filter(state => state.pinned).map(state => state.chatId)))
const statesKey = (account: string) => `chat-pin-states:${account}`
let owner: string | null = null
let generation = 0
let dirty = false
let localClock = 0
let loading: Promise<void> = Promise.resolve()
let writes: Promise<void> = Promise.resolve()

export function loadChatPins(nextOwner: string | null): Promise<void> {
  if (nextOwner === owner) return loading
  owner = nextOwner
  const token = ++generation
  chatPinStates.set({})
  dirty = false
  localClock = 0
  loading = (async () => {
    if (!nextOwner) return
    const versions = await getSessionManagerValue(statesKey(nextOwner))
    if (token !== generation || get(identity)?.pubkey !== nextOwner) return
    const states: Record<string, ChatPinState> = {}
    if (Array.isArray(versions)) for (const state of versions) {
      if (isChatPinState(state) && isNewerChatPin(state, states[state.chatId])) states[state.chatId] = state
    }
    chatPinStates.set(states)
  })()
  return loading
}

export async function mergeChatPins(incoming: ChatPinState[], account: string): Promise<void> {
  if (get(identity)?.pubkey !== account) return
  await loadChatPins(account)
  if (owner !== account || get(identity)?.pubkey !== account) return
  const token = generation
  const states = { ...get(chatPinStates) }
  let changed = false
  for (const state of incoming) {
    if (!isChatPinState(state) || state.updatedAtMs > Date.now() + 300_000 || !isNewerChatPin(state, states[state.chatId])) continue
    states[state.chatId] = { ...state }
    changed = true
  }
  if (!changed && !dirty) return
  if (changed) {
    dirty = true
    chatPinStates.set(states)
  }
  const versions = get(chatPinStates)
  const write = writes.then(async () => {
    if (token !== generation || get(identity)?.pubkey !== account) return
    await putSessionManagerValue(statesKey(account), Object.values(versions))
    if (token === generation && get(chatPinStates) === versions) dirty = false
  })
  writes = write.catch(() => {})
  await write
}

export async function setChatPinned(chatId: string, pinned: boolean): Promise<void> {
  const account = get(identity)?.pubkey
  if (!account || !chatId) return
  await loadChatPins(account)
  if (owner !== account || get(identity)?.pubkey !== account) return
  localClock = Math.max(Date.now(), localClock + 1, (get(chatPinStates)[chatId]?.updatedAtMs ?? 0) + 1)
  const pin = { chatId, pinned, updatedAtMs: localClock }
  if (!isChatPinState(pin)) return
  await mergeChatPins([pin], account)
  if (owner !== account || get(identity)?.pubkey !== account) return
  void import('./chatPinControl').then(({ sendChatPinControl }) => sendChatPinControl(account, pin))
    .catch(error => console.warn('Could not send pin setting to linked devices', error))
}

/** Drain earlier writes before normal logout clears the shared database. */
export async function clearChatPins(): Promise<void> {
  const previous = owner
  ++generation
  owner = null
  chatPinStates.set({})
  dirty = false
  localClock = 0
  loading = Promise.resolve()
  await writes
  if (previous) await deleteSessionManagerValue(statesKey(previous))
}

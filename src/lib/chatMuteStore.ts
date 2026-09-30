import { get, writable } from 'svelte/store'
import { identity } from './identity'
import { getSessionManagerValue, putSessionManagerValue, deleteSessionManagerValue } from './storage'
import { chatMutesKey, normalizeChatMutes, type ChatMutes } from './chatMutePolicy'
import { isChatMuteState, isNewerChatMute, type ChatMuteState } from './chatMuteSync'

export const chatMuteStates = writable<Record<string, ChatMuteState>>({})
const statesKey = (account: string) => `chat-mute-states:${account}`

export const chatMutes = writable<ChatMutes>({})
let owner: string | null = null
let generation = 0
let dirty = false
let localClock = 0
let loading: Promise<void> = Promise.resolve()
let writes: Promise<void> = Promise.resolve()
let timer: ReturnType<typeof setTimeout> | undefined

function scheduleExpiry() {
  clearTimeout(timer)
  const now = Math.floor(Date.now() / 1000)
  const next = Math.min(...Object.values(get(chatMutes)).filter(until => until > now))
  if (!Number.isFinite(next)) return
  const token = generation
  timer = setTimeout(() => {
    if (token !== generation) return
    chatMutes.update(mutes => Object.fromEntries(Object.entries(mutes).filter(([, until]) => until === 0 || until > Math.floor(Date.now() / 1000))))
    scheduleExpiry()
    void refreshPush(token).catch(error => console.warn('Could not refresh muted notifications', error))
  }, Math.min(2_147_483_647, Math.max(1, next * 1000 - Date.now())))
}

async function refreshPush(token: number) {
  const { updateDMSubscription } = await import('./notifications')
  if (token === generation && owner && get(identity)?.pubkey === owner) await updateDMSubscription()
}

export function loadChatMutes(nextOwner: string | null): Promise<void> {
  if (nextOwner === owner) return loading
  owner = nextOwner
  const token = ++generation
  clearTimeout(timer)
  chatMutes.set({})
  chatMuteStates.set({})
  dirty = false
  localClock = 0
  loading = (async () => {
    if (!nextOwner) return
    const [value, versions] = await Promise.all([
      getSessionManagerValue(chatMutesKey(nextOwner)), getSessionManagerValue(statesKey(nextOwner)),
    ])
    if (token !== generation || get(identity)?.pubkey !== nextOwner) return
    const states: Record<string, ChatMuteState> = {}
    for (const [chatId, untilSecs] of Object.entries(normalizeChatMutes(value))) {
      const legacy = { chatId, untilSecs, updatedAtMs: 1 }
      if (isChatMuteState(legacy)) states[chatId] = legacy
    }
    if (Array.isArray(versions)) for (const state of versions) {
      if (isChatMuteState(state) && isNewerChatMute(state, states[state.chatId])) states[state.chatId] = state
    }
    chatMuteStates.set(states)
    projectMutes(states)
    scheduleExpiry()
  })()
  return loading
}

function projectMutes(states: Record<string, ChatMuteState>) {
  const now = Math.floor(Date.now() / 1000)
  chatMutes.set(Object.fromEntries(Object.values(states)
    .filter(state => state.untilSecs !== null && (state.untilSecs === 0 || state.untilSecs > now))
    .map(state => [state.chatId, state.untilSecs as number])))
}

export async function mergeChatMutes(incoming: ChatMuteState[], account: string): Promise<void> {
  if (get(identity)?.pubkey !== account) return
  await loadChatMutes(account)
  if (owner !== account || get(identity)?.pubkey !== account) return
  const token = generation
  const states = { ...get(chatMuteStates) }
  let changed = false
  for (const state of incoming) {
    if (!isChatMuteState(state) || state.updatedAtMs > Date.now() + 300_000 ||
      !isNewerChatMute(state, states[state.chatId])) continue
    states[state.chatId] = { ...state }
    changed = true
  }
  if (!changed && !dirty) return
  if (changed) {
    dirty = true
    chatMuteStates.set(states)
    projectMutes(states)
    scheduleExpiry()
  }
  const versions = get(chatMuteStates)
  const values = get(chatMutes)
  const write = writes.then(async () => {
    if (token !== generation || get(identity)?.pubkey !== account) return
    // The authoritative versions (including unmute tombstones) are saved first.
    await putSessionManagerValue(statesKey(account), Object.values(versions))
    if (token === generation && get(identity)?.pubkey === account)
      await putSessionManagerValue(chatMutesKey(account), values)
    if (token === generation && get(chatMuteStates) === versions) dirty = false
  })
  writes = write.catch(() => {})
  await write
  void refreshPush(token).catch(error => console.warn('Could not refresh muted notifications', error))
}

export async function setChatMute(chatId: string, durationSeconds: number | null): Promise<void> {
  const account = get(identity)?.pubkey
  if (!account || !chatId) return
  await loadChatMutes(account)
  if (owner !== account || get(identity)?.pubkey !== account) return
  localClock = Math.max(Date.now(), localClock + 1, (get(chatMuteStates)[chatId]?.updatedAtMs ?? 0) + 1)
  const mute = {
    chatId,
    untilSecs: durationSeconds === null ? null : durationSeconds === 0 ? 0 : Math.floor(Date.now() / 1000) + durationSeconds,
    updatedAtMs: localClock,
  }
  if (!isChatMuteState(mute)) return
  await mergeChatMutes([mute], account)
  if (owner !== account || get(identity)?.pubkey !== account) return
  void import('./chatMuteControl').then(({ sendChatMuteControl }) => sendChatMuteControl(account, mute))
    .catch(error => console.warn('Could not send mute setting to linked devices', error))
}

/** Drain earlier writes before normal logout clears the shared database. */
export async function clearChatMutes(): Promise<void> {
  const previous = owner
  ++generation
  owner = null
  clearTimeout(timer)
  chatMutes.set({})
  chatMuteStates.set({})
  dirty = false
  localClock = 0
  loading = Promise.resolve()
  await writes
  if (previous) {
    await deleteSessionManagerValue(chatMutesKey(previous))
    await deleteSessionManagerValue(statesKey(previous))
  }
}

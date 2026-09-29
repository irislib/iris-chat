import { get, writable } from 'svelte/store'
import { identity } from './identity'
import { getSessionManagerValue, putSessionManagerValue, deleteSessionManagerValue } from './storage'
import { chatMutesKey, normalizeChatMutes, type ChatMutes } from './chatMutePolicy'

export const chatMutes = writable<ChatMutes>({})
let owner: string | null = null
let generation = 0
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
  loading = (async () => {
    if (!nextOwner) return
    const value = await getSessionManagerValue(chatMutesKey(nextOwner))
    if (token !== generation || get(identity)?.pubkey !== nextOwner) return
    chatMutes.set(normalizeChatMutes(value))
    scheduleExpiry()
  })()
  return loading
}

export async function setChatMute(chatId: string, durationSeconds: number | null): Promise<void> {
  const account = get(identity)?.pubkey
  if (!account || !chatId) return
  await loadChatMutes(account)
  if (owner !== account || get(identity)?.pubkey !== account) return
  const token = generation
  const values = { ...get(chatMutes) }
  if (durationSeconds === null) delete values[chatId]
  else values[chatId] = durationSeconds === 0 ? 0 : Math.floor(Date.now() / 1000) + durationSeconds
  chatMutes.set(values)
  scheduleExpiry()
  const write = writes.then(async () => {
    if (token === generation && get(identity)?.pubkey === account) await putSessionManagerValue(chatMutesKey(account), values)
  })
  writes = write.catch(() => {})
  await write
  void refreshPush(token).catch(error => console.warn('Could not refresh muted notifications', error))
}

/** Drain earlier writes before normal logout clears the shared database. */
export async function clearChatMutes(): Promise<void> {
  const previous = owner
  ++generation
  owner = null
  clearTimeout(timer)
  chatMutes.set({})
  loading = Promise.resolve()
  await writes
  if (previous) await deleteSessionManagerValue(chatMutesKey(previous))
}

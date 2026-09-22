import { createNostrSubscribe } from './profileAppKeysRuntime'
import { createMessagingPeopleStore, MAX_MESSAGING_PEOPLE, type MessagingSupportEvent } from './messagingPeople'

const CACHE_KEY = 'iris-chat-messaging-people'
let memoryCache: MessagingSupportEvent[] | undefined
let persistTimer: ReturnType<typeof setTimeout> | undefined
function persist() {
  clearTimeout(persistTimer)
  persistTimer = undefined
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(memoryCache)) } catch { /* Storage can be unavailable. */ }
}
// A visible result must survive a reload before the coalesced write fires.
window.addEventListener('pagehide', () => { if (persistTimer) persist() })

function cachedEvents(): MessagingSupportEvent[] {
  if (memoryCache) return memoryCache
  try {
    const events = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]')
    memoryCache = Array.isArray(events) ? events.slice(0, MAX_MESSAGING_PEOPLE * 2) : []
  } catch { memoryCache = [] }
  return memoryCache!
}

export function createRuntimeMessagingPeopleStore(owners: string[]) {
  return createMessagingPeopleStore(owners, {
    subscribe: createNostrSubscribe(),
    initialEvents: cachedEvents(),
    onCache: (events, critical) => {
      const updated = new Set(events.map(event => event.pubkey))
      const saved = [...events, ...cachedEvents().filter(event => event && !updated.has(event.pubkey))]
      memoryCache = saved.slice(0, MAX_MESSAGING_PEOPLE * 2)
      // Revocations/conflicts must survive an immediate reload. Coalesce only
      // ordinary positive discovery responses during a burst of profile hits.
      if (critical) persist()
      else if (!persistTimer) persistTimer = setTimeout(persist, 50)
    },
  })
}

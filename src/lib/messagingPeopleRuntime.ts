import { createNostrSubscribe } from './profileAppKeysRuntime'
import { createMessagingPeopleStore, MAX_MESSAGING_PEOPLE, type MessagingSupportEvent } from './messagingPeople'

const CACHE_KEY = 'iris-chat-messaging-people'
function cachedEvents(): MessagingSupportEvent[] {
  try {
    const events = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]')
    return Array.isArray(events) ? events.slice(0, MAX_MESSAGING_PEOPLE * 2) : []
  } catch { return [] }
}

export function createRuntimeMessagingPeopleStore(owners: string[]) {
  return createMessagingPeopleStore(owners, {
    subscribe: createNostrSubscribe(),
    initialEvents: cachedEvents(),
    onCache: events => {
      const updated = new Set(events.map(event => event.pubkey))
      const saved = [...events, ...cachedEvents().filter(event => event && !updated.has(event.pubkey))]
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(saved.slice(0, MAX_MESSAGING_PEOPLE * 2))) } catch { /* Storage can be unavailable. */ }
    },
  })
}

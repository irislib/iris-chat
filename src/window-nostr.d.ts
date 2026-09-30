import type { Event, EventTemplate } from 'nostr-tools'
declare global {
  interface Window { nostr?: { getPublicKey(): Promise<string>; signEvent(event: EventTemplate): Promise<Event> } }
}
export {}

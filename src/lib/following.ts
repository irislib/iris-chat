import { writable, get } from 'svelte/store'
import { verifyEvent, type Event } from 'nostr-tools'
import type { NDKEvent, NDKSubscription } from '@nostr-dev-kit/ndk'
import { identity, ndk } from './identity'
import {
  asNdkEventSubscription,
  type NdkEventSubscription,
} from './ndkSubscription'

// Set of pubkeys we follow (based on kind:3 contact list).
export const following = writable<Set<string>>(new Set())

let sub: NdkEventSubscription | null = null
let identityUnsub: (() => void) | null = null
let lastPubkey: string | null = null
let latestCreatedAt = 0

function stopSubscription(): void {
  try {
    sub?.stop()
  } catch {
    // ignore
  }
  sub = null
  latestCreatedAt = 0
}

function parseFollowingFromEvent(raw: Event): Set<string> {
  const next = new Set<string>()
  for (const tag of raw?.tags || []) {
    if (tag[0] === 'p' && typeof tag[1] === 'string' && tag[1].length > 0) {
      next.add(tag[1])
    }
  }
  return next
}

const FOLLOWING_CACHE_PREFIX = 'iris-chat-following:'
function validFollowEvent(event: Event, owner: string): boolean {
  try {
    return event?.kind === 3 && event.pubkey === owner &&
      event.created_at <= Math.floor(Date.now() / 1000) + 300 && verifyEvent(event)
  } catch { return false }
}
function cachedFollowing(owner: string): Event | undefined {
  try {
    const event = JSON.parse(localStorage.getItem(FOLLOWING_CACHE_PREFIX + owner) || 'null')
    return validFollowEvent(event, owner) ? event : undefined
  } catch { return undefined }
}

// Call once on app start. Returns a cleanup function.
export function initFollowing(): () => void {
  if (identityUnsub) return () => {}

  identityUnsub = identity.subscribe((id) => {
    const pubkey = id?.pubkey || null
    if (pubkey === lastPubkey) return
    lastPubkey = pubkey

    stopSubscription()
    following.set(new Set())

    if (!pubkey) return

    const cached = cachedFollowing(pubkey)
    if (cached) following.set(parseFollowingFromEvent(cached))
    const ndkInstance = get(ndk)
    latestCreatedAt = cached?.created_at ?? 0

    // Keep listening; contact list updates should take effect immediately.
    sub = asNdkEventSubscription(ndkInstance.subscribe(
      { kinds: [3], authors: [pubkey], limit: 1 },
      { closeOnEose: false }
    ))

    sub.on('event', (ev: NDKEvent) => {
      const raw = ev.rawEvent() as Event
      if (!validFollowEvent(raw, pubkey)) return
      const createdAt = raw.created_at
      if (createdAt && createdAt < latestCreatedAt) return
      latestCreatedAt = createdAt
      following.set(parseFollowingFromEvent(raw))
      try { localStorage.setItem(FOLLOWING_CACHE_PREFIX + pubkey, JSON.stringify(raw)) } catch { /* Storage can be unavailable. */ }
    })
  })

  return () => {
    identityUnsub?.()
    identityUnsub = null
    lastPubkey = null
    stopSubscription()
    following.set(new Set())
  }
}

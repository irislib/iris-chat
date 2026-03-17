import { writable, get } from 'svelte/store'
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

function parseFollowingFromEvent(event: NDKEvent): Set<string> {
  const raw = event.rawEvent?.() as { tags?: string[][]; created_at?: number } | undefined
  const next = new Set<string>()
  for (const tag of raw?.tags || []) {
    if (tag[0] === 'p' && typeof tag[1] === 'string' && tag[1].length > 0) {
      next.add(tag[1])
    }
  }
  return next
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

    const ndkInstance = get(ndk)
    latestCreatedAt = 0

    // Keep listening; contact list updates should take effect immediately.
    sub = asNdkEventSubscription(ndkInstance.subscribe(
      { kinds: [3], authors: [pubkey], limit: 1 },
      { closeOnEose: false }
    ))

    sub.on('event', (ev: NDKEvent) => {
      const raw = ev.rawEvent?.() as { created_at?: number } | undefined
      const createdAt = raw?.created_at || 0
      if (createdAt && createdAt < latestCreatedAt) return
      latestCreatedAt = createdAt
      following.set(parseFollowingFromEvent(ev))
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

import { writable, type Readable, get } from 'svelte/store'
import { ndk } from './identity'
import { saveProfileToStorage } from './storage'

export interface Profile {
  pubkey: string
  name?: string
  display_name?: string
  username?: string
  picture?: string
  nip05?: string
}

// Local profile rumor (unsigned kind 0 event content)
const LOCAL_PROFILE_KEY = 'iris-chat-local-profile'

// In-memory profile cache
const profileCache = new Map<string, Profile>()

// Load local profile from storage
function loadLocalProfile(): Profile | null {
  try {
    const stored = localStorage.getItem(LOCAL_PROFILE_KEY)
    if (stored) {
      return JSON.parse(stored)
    }
  } catch {
    // ignore
  }
  return null
}

// Save local profile rumor
export function saveLocalProfile(pubkey: string, name: string): Profile {
  const profile: Profile = {
    pubkey,
    name,
    display_name: name,
  }
  try {
    localStorage.setItem(LOCAL_PROFILE_KEY, JSON.stringify(profile))
  } catch {
    // ignore
  }
  // Also add to cache
  profileCache.set(pubkey, profile)
  notifyListeners(pubkey, profile)

  // Save to IndexedDB for service worker access
  saveProfileToStorage({
    pubkey,
    name: profile.name,
    display_name: profile.display_name,
    picture: profile.picture,
    updatedAt: Date.now()
  }).catch(e => console.error('[profile] failed to save local profile to IndexedDB', e))

  return profile
}

// Get the local profile rumor (for sending to peers)
export function getLocalProfile(): Profile | null {
  return loadLocalProfile()
}

// Add a received profile to the cache (from data channel)
export function addProfileToCache(profile: Profile): void {
  if (!profile.pubkey) return
  profileCache.set(profile.pubkey, profile)
  notifyListeners(profile.pubkey, profile)

  // Save to IndexedDB for service worker access
  saveProfileToStorage({
    pubkey: profile.pubkey,
    name: profile.name,
    display_name: profile.display_name,
    picture: profile.picture,
    updatedAt: Date.now()
  }).catch(e => console.error('[profile] failed to save to IndexedDB', e))
}

// Clear local profile on logout
export function clearLocalProfile(): void {
  try {
    localStorage.removeItem(LOCAL_PROFILE_KEY)
  } catch {
    // ignore
  }
}

// Initialize: load local profile into cache
const localProfile = loadLocalProfile()
if (localProfile) {
  profileCache.set(localProfile.pubkey, localProfile)
}

// Track in-flight fetches
const pendingFetches = new Set<string>()

// Listeners for profile updates
type ProfileListener = (profile: Profile) => void
const listeners = new Map<string, Set<ProfileListener>>()

function subscribe(pubkey: string, listener: ProfileListener): () => void {
  let set = listeners.get(pubkey)
  if (!set) {
    set = new Set()
    listeners.set(pubkey, set)
  }
  set.add(listener)
  return () => {
    set!.delete(listener)
    if (set!.size === 0) listeners.delete(pubkey)
  }
}

function notifyListeners(pubkey: string, profile: Profile) {
  const set = listeners.get(pubkey)
  if (set) {
    set.forEach(fn => fn(profile))
  }
}

async function fetchProfile(pubkey: string): Promise<void> {
  if (pendingFetches.has(pubkey)) return

  pendingFetches.add(pubkey)

  try {
    const ndkInstance = get(ndk)
    const events = await ndkInstance.fetchEvents({ kinds: [0], authors: [pubkey], limit: 1 })

    if (events.size > 0) {
      const eventsArray = Array.from(events)
      const event = eventsArray.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0]
      try {
        const profile = JSON.parse(event.content) as Profile
        profile.pubkey = event.pubkey
        profileCache.set(pubkey, profile)
        notifyListeners(pubkey, profile)

        // Save to IndexedDB for service worker access
        saveProfileToStorage({
          pubkey,
          name: profile.name,
          display_name: profile.display_name,
          picture: profile.picture,
          updatedAt: Date.now()
        }).catch(e => console.error('[profile] failed to save to IndexedDB', e))
      } catch (e) {
        console.error('[profile] JSON parse error', e)
      }
    }
  } catch (e) {
    console.error('[profile] fetch error', e)
  } finally {
    pendingFetches.delete(pubkey)
  }
}

export function createProfileStore(pubkey: string | undefined): Readable<Profile | undefined> {
  if (!pubkey) {
    const store = writable<Profile | undefined>(undefined)
    return { subscribe: store.subscribe }
  }

  const store = writable<Profile | undefined>(profileCache.get(pubkey))

  const unsubListener = subscribe(pubkey, (profile) => {
    store.set(profile)
  })

  if (!profileCache.get(pubkey)) {
    fetchProfile(pubkey)
  }

  return {
    subscribe: (run, invalidate) => {
      const unsubStore = store.subscribe(run, invalidate)
      return () => {
        unsubStore()
        unsubListener()
      }
    },
  }
}

export function getProfileName(profile?: Profile): string | undefined {
  if (!profile) return undefined
  return profile.display_name || profile.name || profile.username ||
         (profile.nip05 ? profile.nip05.split('@')[0] : undefined)
}

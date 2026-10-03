import { verifiedProfileEvent } from './deviceSyncRecords'
import { saveSignedProfileHead, signedProfileHeads } from './deviceSyncRecordStore'
import { readable, type Readable, get } from 'svelte/store'
import type { EventSubscription } from './nostrClient'
import { identity, nostrClient, getPubkey } from './identity'
import { saveProfileToStorage, getProfileFromStorage } from './storage'
import { observeContactProfile } from './contactMemory'

export interface Profile {
  pubkey: string
  eventCreatedAt?: number
  eventId?: string
  name?: string
  display_name?: string
  username?: string
  picture?: string
  nip05?: string
  about?: string
}

// Local profile rumor (unsigned kind 0 event content)
const LOCAL_PROFILE_KEY = 'iris-chat-local-profile'

// In-memory profile cache
const profileCache = new Map<string, Profile>()

export function getCachedPeopleProfiles(): Profile[] {
  return [...profileCache.values()]
}

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

function normalizeProfile(profile: Profile): Profile {
  const normalized: Profile = { ...profile }
  const normalize = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
  }

  normalized.name = normalize(normalized.name)
  normalized.display_name = normalize(normalized.display_name)
  normalized.picture = normalize(normalized.picture)
  normalized.nip05 = normalize(normalized.nip05)
  normalized.about = normalize(normalized.about)

  if (!normalized.display_name && normalized.name) {
    normalized.display_name = normalized.name
  }
  if (!normalized.name && normalized.display_name) {
    normalized.name = normalized.display_name
  }

  return normalized
}

function persistProfile(profile: Profile): void {
  try {
    localStorage.setItem(LOCAL_PROFILE_KEY, JSON.stringify(profile))
  } catch {
    // ignore
  }

  profileCache.set(profile.pubkey, profile)
  notifyListeners(profile.pubkey, profile)

  // Save to IndexedDB for service worker access
  saveProfileToStorage({
    pubkey: profile.pubkey,
    eventCreatedAt: profile.eventCreatedAt,
    eventId: profile.eventId,
    name: profile.name,
    display_name: profile.display_name,
    username: profile.username,
    nip05: profile.nip05,
    picture: profile.picture,
    updatedAt: Date.now()
  }).catch(e => console.error('[profile] failed to save local profile to IndexedDB', e))

}

// Save local profile rumor
export function saveLocalProfile(pubkey: string, name: string): Profile {
  return updateLocalProfile(pubkey, {
    name,
    display_name: name,
  })
}

// Merge profile fields into local profile rumor
export function updateLocalProfile(
  pubkey: string,
  updates: Partial<Omit<Profile, 'pubkey'>>
): Profile {
  const existing = loadLocalProfile()
  const merged: Profile = normalizeProfile({
    ...(existing ?? { pubkey }),
    pubkey,
    ...updates,
  })
  persistProfile(merged)
  return merged
}

// Get the local profile rumor (for sending to peers)
export function getLocalProfile(): Profile | null {
  return loadLocalProfile()
}

// Add a received profile to the cache (from data channel)
export function addProfileToCache(profile: Profile, persist = true): void {
  if (!profile.pubkey) return
  const previous = profileCache.get(profile.pubkey)
  if (previous?.eventCreatedAt !== undefined &&
      ((profile.eventCreatedAt !== undefined && (profile.eventCreatedAt < previous.eventCreatedAt || profile.eventCreatedAt === previous.eventCreatedAt && !!previous.eventId && (!profile.eventId || profile.eventId > previous.eventId))) ||
       (!persist && profile.eventCreatedAt === undefined))) return
  profileCache.set(profile.pubkey, profile)
  notifyListeners(profile.pubkey, profile)
  if (!persist) return

  // Save to IndexedDB for service worker access
  saveProfileToStorage({
    pubkey: profile.pubkey,
    eventCreatedAt: profile.eventCreatedAt,
    eventId: profile.eventId,
    name: profile.name,
    display_name: profile.display_name,
    username: profile.username,
    nip05: profile.nip05,
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

// One live metadata subscription per visible contact.
const activeProfiles = new Map<string, { refs: number; sub: EventSubscription }>()

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
  observeContactProfile(get(identity)?.pubkey ?? '', pubkey, getProfileName(profile) ?? null)
  const set = listeners.get(pubkey)
  if (set) {
    set.forEach(fn => fn(profile))
  }
}

export async function observeSignedProfile(value: unknown): Promise<void> {
  let event = verifiedProfileEvent(value)
  if (!event) return
  const owner = getPubkey()
  if (owner) {
    await saveSignedProfileHead(owner, event)
    event = (await signedProfileHeads(owner, new Set([event.pubkey])))[0]
    if (!event) return
  }
  const data = JSON.parse(event.content)
  const profile: Profile = { pubkey: event.pubkey, eventCreatedAt: event.created_at, eventId: event.id }
  for (const field of ['name', 'display_name', 'username', 'picture', 'nip05', 'about'] as const) {
    if (typeof data[field] === 'string') profile[field] = data[field]
  }
  addProfileToCache(profile)
}

function keepProfileLoaded(pubkey: string): () => void {
  const existing = activeProfiles.get(pubkey)
  if (existing) {
    existing.refs++
  } else {
    if (!profileCache.has(pubkey)) {
      void getProfileFromStorage(pubkey).then(cached => {
        if (cached) addProfileToCache(cached, false)
      }).catch(() => {})
    }
    const owner = getPubkey()
    if (owner) void signedProfileHeads(owner, new Set([pubkey])).then(heads => heads[0] && observeSignedProfile(heads[0])).catch(() => {})
    const sub = get(nostrClient).subscribe(
      { kinds: [0], authors: [pubkey], limit: 1 }, { closeOnEose: false },
    )
    activeProfiles.set(pubkey, { refs: 1, sub })
    sub.on('event', event => {
      if (event.pubkey !== pubkey) return
      void observeSignedProfile(event.rawEvent()).catch(() => {})
    })
  }
  return () => {
    const active = activeProfiles.get(pubkey)
    if (active && --active.refs === 0) { active.sub.stop(); activeProfiles.delete(pubkey) }
  }
}

export function createProfileStore(pubkey: string | undefined, load = true): Readable<Profile | undefined> {
  return readable<Profile | undefined>(pubkey ? profileCache.get(pubkey) : undefined, set => {
    if (!pubkey) return
    set(profileCache.get(pubkey))
    const stopListener = subscribe(pubkey, set)
    const stopLoading = load ? keepProfileLoaded(pubkey) : undefined
    return () => { stopListener(); stopLoading?.() }
  })
}

export function getProfileName(profile?: Profile): string | undefined {
  if (!profile) return undefined
  return [profile.display_name, profile.name, profile.username,
    typeof profile.nip05 === 'string' ? profile.nip05.split('@')[0] : undefined]
    .find(value => typeof value === 'string' && !!value.trim())
}

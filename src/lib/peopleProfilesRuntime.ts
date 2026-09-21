import { readable } from 'svelte/store'
import { verifyEvent, type Event } from 'nostr-tools'
import { createNostrSubscribe } from './profileAppKeysRuntime'
import { addProfileToCache, getCachedPeopleProfiles, type Profile } from './profile'
import { getPeopleProfilesFromStorage } from './storage'
import { peopleSearchScore } from './peopleSearch'

export interface PeopleProfilesState {
  profiles: Map<string, Profile>
  loading: boolean
  unavailable?: boolean
}

// Name lookups run alongside device discovery, in batches, instead of waiting
// for each person's device list and then issuing a separate profile request.
export function createRuntimePeopleProfilesStore(options: { owners?: string[]; query?: string }) {
  const owners = options.owners ? [...new Set(options.owners)].slice(0, 512) : undefined
  const requested = owners ? new Set(owners) : undefined
  const query = options.query?.trim().toLowerCase() ?? ''
  const matches = (profile: Profile) => requested ? requested.has(profile.pubkey) : !!query &&
    peopleSearchScore(profile, query, { followDistance: 999, friendsFollowing: 0 }) > -Infinity
  const initial = getCachedPeopleProfiles().filter(matches)
  const shouldFetch = owners ? owners.length > 0 : query.length >= 2
  if (!owners && !query) return readable<PeopleProfilesState>({ profiles: new Map(), loading: false })
  return readable<PeopleProfilesState>({ profiles: new Map(initial.map(profile => [profile.pubkey, profile])), loading: shouldFetch }, set => {
    let active = true
    let loading = shouldFetch
    let unavailable = false
    const profiles = new Map(initial.map(profile => [profile.pubkey, profile]))
    const latest = new Map<string, number>()
    const stops: Array<() => void> = []
    const controller = new AbortController()
    let scheduled: ReturnType<typeof setTimeout> | undefined
    const publish = () => {
      if (!active || scheduled) return
      scheduled = setTimeout(() => {
        scheduled = undefined
        if (active) set({ profiles: new Map(profiles), loading, unavailable })
      }, 20)
    }
    void getPeopleProfilesFromStorage(owners).then(cached => {
      if (!active) return
      for (const profile of cached) {
        if (!matches(profile) && !profiles.has(profile.pubkey)) continue
        addProfileToCache(profile, false)
        if (!profiles.has(profile.pubkey) || (profile.eventCreatedAt ?? -1) > (profiles.get(profile.pubkey)?.eventCreatedAt ?? -1)) profiles.set(profile.pubkey, profile)
      }
      publish()
    }).catch(() => {})
    const receive = (raw: Event) => {
      if (!active || raw.kind !== 0 || raw.content.length > 16384 || !Number.isSafeInteger(raw.created_at) ||
          raw.created_at > Date.now() / 1000 + 300 || (requested && !requested.has(raw.pubkey)) ||
          raw.created_at <= (latest.get(raw.pubkey) ?? -1)) return
      try {
        if (!verifyEvent(raw)) return
        const data = JSON.parse(raw.content)
        const profile: Profile = { pubkey: raw.pubkey, eventCreatedAt: raw.created_at }
        for (const field of ['name', 'display_name', 'username', 'nip05', 'picture'] as const) {
          if (typeof data?.[field] === 'string') profile[field] = data[field].slice(0, field === 'picture' ? 2048 : 256)
        }
        latest.set(raw.pubkey, raw.created_at)
        if (!matches(profile)) { profiles.delete(raw.pubkey); publish(); return }
        if (!profiles.has(raw.pubkey) && profiles.size >= 512) return
        profiles.set(raw.pubkey, profile)
        addProfileToCache(profile)
        publish()
      } catch { /* Ignore malformed public metadata. */ }
    }
    const start = () => {
      if (!active || !shouldFetch) return
      if (!owners) {
        void import('./peopleSearchIndex').then(({ searchPeopleIndex }) => searchPeopleIndex(query, {
          signal: controller.signal,
          onProfileUpdate: profile => {
            if (!active || (profile.eventCreatedAt ?? -1) < (profiles.get(profile.pubkey)?.eventCreatedAt ?? -1)) return
            addProfileToCache(profile)
            // Keep renamed, nonmatching records so older sources cannot bring
            // the old matching name back during this query.
            if (profiles.has(profile.pubkey) || profiles.size < 512) profiles.set(profile.pubkey, profile)
            publish()
          },
          onProfiles: incoming => {
            if (!active) return
            for (const profile of incoming) {
              if (!matches(profile) || (!profiles.has(profile.pubkey) && profiles.size >= 512) ||
                  (profile.eventCreatedAt ?? -1) < (profiles.get(profile.pubkey)?.eventCreatedAt ?? -1)) continue
              profiles.set(profile.pubkey, profile)
              addProfileToCache(profile)
            }
            publish()
          },
        })).catch(() => { unavailable = true }).finally(() => { loading = false; publish() })
        return
      }
      const subscribe = createNostrSubscribe()
      const filters = Array.from({ length: Math.ceil(owners.length / 64) }, (_, batch) => ({ kinds: [0], authors: owners.slice(batch * 64, batch * 64 + 64), limit: 256 }))
      let pending = filters.length
      for (const filter of filters) {
        let done = false
        stops.push(subscribe(filter, event => receive(event as Event), () => {
          if (!active || done) return
          done = true
          if (--pending === 0) { loading = false; publish() }
        }))
      }
    }
    // Typing replaces this store and cancels its subscriptions/timer immediately.
    const debounce = setTimeout(start, owners ? 0 : 150)
    const timeout = owners ? setTimeout(() => { loading = false; publish() }, 2500) : undefined
    return () => {
      active = false
      controller.abort()
      clearTimeout(debounce)
      clearTimeout(timeout)
      clearTimeout(scheduled)
      for (const stop of stops) stop()
    }
  })
}

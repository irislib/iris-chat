import { SocialGraph } from 'nostr-social-graph'
import { verifyEvent, type Event } from 'nostr-tools'
import { get, writable } from 'svelte/store'
import Dexie from 'dexie'
import { identity, ndk } from './identity'
import { following, followingHead } from './following'
import { asNdkEventSubscription } from './ndkSubscription'

const MAX_NEAR_AUTHORS = 512
const AUTHOR_BATCH_SIZE = 128
const MAX_EVENT_BYTES = 64 * 1024
const MAX_CACHE_BYTES = 2 * 1024 * 1024
const MAX_CACHE_EVENTS = 2 * (MAX_NEAR_AUTHORS + 1)
const PUBKEY = /^[0-9a-f]{64}$/
// Sirius, also the default discovery root in Iris Social. This is a local
// discovery edge only; it never changes or publishes the account's follow list.
export const DEFAULT_DISCOVERY_PUBKEY = '4523be58d395b1b196a9b8c82b038b6895cb02b683d0c253a955068dba1facd0'

export interface PeopleGraphState {
  ownerPubkey: string | null
  ready: boolean
  version: number
}
export interface PeopleGraphSignals {
  followDistance: number
  friendsFollowing: number
  overmuted: boolean
}

/** Ordinary people search uses threshold 1; the stricter feed policy is different. */
export function graphConsidersUserOvermuted(graph: SocialGraph, pubkey: string): boolean {
  if (pubkey === graph.getRoot()) return false
  const muters = graph.getUserMutedBy(pubkey)
  if (!muters.size) return false
  if (muters.has(graph.getRoot())) return true
  const nearest = Object.entries(graph.stats(pubkey))
    .sort(([left], [right]) => Number(left) - Number(right))
    .find(([, counts]) => counts.followers + counts.muters > 0)?.[1]
  return !!nearest && nearest.muters > nearest.followers
}

interface PeopleGraphOptions {
  loadGraph: (owner: string) => Promise<SocialGraph>
  loadEvents: (owner: string) => Promise<Event[]>
  saveEvents: (owner: string, events: Event[]) => Promise<void>
  subscribe: (authors: string[], event: (event: Event) => void, done: () => void) => () => void
  changed: (state: PeopleGraphState) => void
}

function validOpinion(event: Event): boolean {
  try {
    // Do not inherit nostr-tools' cached verification symbol from an NDK event.
    const wire = { id: event.id, pubkey: event.pubkey, kind: event.kind,
      created_at: event.created_at, tags: event.tags, content: event.content, sig: event.sig }
    return (event.kind === 3 || event.kind === 10000) && PUBKEY.test(event.pubkey) &&
      event.tags.length <= 2048 && Number.isInteger(event.created_at) && event.created_at >= 0 &&
      event.created_at <= Math.floor(Date.now() / 1000) + 300 &&
      JSON.stringify(wire).length <= MAX_EVENT_BYTES && verifyEvent(wire)
  } catch { return false }
}

/** Identity-scoped graph hydration. Relay completion never gates the local snapshot. */
export class PeopleGraphController {
  state: PeopleGraphState = { ownerPubkey: null, ready: false, version: 0 }
  private graph: SocialGraph | null = null
  private generation = 0
  private stops = new Set<() => void>()
  private events = new Map<string, Event>()
  private knownFollows = new Set<string>()
  private queried = new Set<string>()
  private hydrating = false
  private discoveryEdge = false
  private signalCache = new Map<string, PeopleGraphSignals>()
  private candidateCache = new Map<string, string[]>()
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private saveTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: PeopleGraphOptions) {}

  private emit() {
    this.signalCache.clear()
    this.candidateCache.clear()
    this.state = { ...this.state, version: this.state.version + 1 }
    this.options.changed(this.state)
  }

  async setOwner(owner: string | null): Promise<void> {
    if (owner === this.state.ownerPubkey) return
    this.stop()
    const generation = this.generation
    this.state = { ownerPubkey: owner, ready: false, version: this.state.version }
    this.emit()
    if (!owner) return

    this.graph = new SocialGraph(owner)
    this.updateDiscoveryEdge()
    this.emit()
    this.listen([owner], generation)

    const [graph, cached] = await Promise.all([
      this.options.loadGraph(owner).catch(() => new SocialGraph(owner)),
      this.options.loadEvents(owner).catch(() => []),
    ])
    if (generation !== this.generation) return
    const live = [...this.events.values()]
    this.graph = graph
    this.discoveryEdge = false
    this.events.clear()
    const valid = [...(Array.isArray(cached) ? cached.slice(-MAX_CACHE_EVENTS) : []), ...live]
      .filter(validOpinion).sort((left, right) => left.created_at - right.created_at)
    for (const event of valid.filter(event => event.pubkey === owner)) this.remember(event)
    this.updateDiscoveryEdge()
    await graph.recalculateFollowDistances()
    if (generation !== this.generation) return
    for (const event of valid.filter(event => event.pubkey !== owner)) {
      if (graph.getFollowDistance(event.pubkey) <= 2) this.remember(event)
    }
    await graph.recalculateFollowDistances()
    if (generation !== this.generation) return
    this.state = { ...this.state, ready: true }
    this.emit()
    void this.hydrateNear(generation)
  }

  setFollowing(follows: Set<string>) {
    this.knownFollows = new Set([...follows].filter(key => PUBKEY.test(key)).slice(0, MAX_NEAR_AUTHORS))
    if (this.updateDiscoveryEdge()) void this.flush()
    if (this.graph) void this.hydrateNear(this.generation)
  }

  private updateDiscoveryEdge(): boolean {
    if (!this.graph || !this.state.ownerPubkey) return false
    const owner = this.state.ownerPubkey
    const follows = this.graph.getFollowedByUser(owner)
    if (this.discoveryEdge) follows.delete(DEFAULT_DISCOVERY_PUBKEY)
    const needed = owner !== DEFAULT_DISCOVERY_PUBKEY && !follows.size && !this.knownFollows.size &&
      !this.graph.getUserMutedBy(DEFAULT_DISCOVERY_PUBKEY).has(owner)
    if (needed === this.discoveryEdge) return false
    if (needed) this.graph.addFollower(owner, DEFAULT_DISCOVERY_PUBKEY)
    else this.graph.removeFollower(owner, DEFAULT_DISCOVERY_PUBKEY)
    this.discoveryEdge = needed
    return true
  }

  setFollowingHead(event: Event | null) {
    if (!event || event.kind !== 3 || event.pubkey !== this.state.ownerPubkey || !validOpinion(event)) return
    if (this.remember(event) && !this.refreshTimer) {
      this.refreshTimer = setTimeout(() => { void this.flush() }, 50)
    }
  }

  private remember(event: Event): boolean {
    const key = `${event.kind}:${event.pubkey}`
    if ((this.events.get(key)?.created_at ?? -1) >= event.created_at) return false
    if (!this.graph?.handleEvent(event, true)) return false
    // A signed contact head replaces all root edges, including the local seed.
    if (event.kind === 3 && event.pubkey === this.state.ownerPubkey) this.discoveryEdge = false
    this.updateDiscoveryEdge()
    this.events.delete(key)
    this.events.set(key, event)
    while (this.events.size > MAX_CACHE_EVENTS) this.events.delete(this.events.keys().next().value!)
    return true
  }

  private listen(authors: string[], generation: number, done: () => void = () => {}) {
    const allowed = new Set(authors)
    const stop = this.options.subscribe(authors, event => {
      if (generation !== this.generation || !allowed.has(event.pubkey) || !validOpinion(event)) return
      if (!this.remember(event)) return
      if (!this.refreshTimer) this.refreshTimer = setTimeout(() => { void this.flush() }, 50)
    }, done)
    this.stops.add(stop)
    return () => { this.stops.delete(stop); stop() }
  }

  async flush() {
    clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
    const generation = this.generation
    await this.graph?.recalculateFollowDistances()
    if (generation !== this.generation || !this.graph) return
    this.emit()
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => { void this.persist() }, 250)
    void this.hydrateNear(generation)
  }

  private async hydrateNear(generation: number) {
    if (this.hydrating || !this.graph || !this.state.ready) return
    this.hydrating = true
    try {
      while (generation === this.generation && this.graph) {
        const root = this.graph.getRoot()
        const authors = [...new Set([...this.knownFollows, ...this.graph.getFollowedByUser(root)])]
          .filter(key => key !== root && PUBKEY.test(key)).slice(0, MAX_NEAR_AUTHORS)
        // Bound retained scheduling state when the account's follows change.
        this.queried = new Set([...this.queried].filter(key => authors.includes(key)))
        const batch = authors.filter(key => !this.queried.has(key)).slice(0, AUTHOR_BATCH_SIZE)
        if (!batch.length) break
        batch.forEach(key => this.queried.add(key))
        await new Promise<void>(resolve => {
          let stop: (() => void) | undefined
          let cancel: (() => void) | undefined
          let finished = false
          const finish = () => {
            if (finished) return
            finished = true
            clearTimeout(timeout)
            if (cancel) this.stops.delete(cancel)
            stop?.()
            resolve()
          }
          const timeout = setTimeout(finish, 2500)
          stop = this.listen(batch, generation, finish)
          if (finished) stop()
          cancel = finish
          if (!finished) this.stops.add(cancel)
        })
        if (generation !== this.generation) break
        await this.graph.recalculateFollowDistances()
        if (generation === this.generation) this.emit()
      }
    } finally {
      if (generation === this.generation) this.hydrating = false
    }
  }

  signals(pubkey: string): PeopleGraphSignals {
    const cached = this.signalCache.get(pubkey)
    if (cached) return cached
    const signals = this.graph ? {
      followDistance: this.graph.getFollowDistance(pubkey),
      friendsFollowing: this.graph.followedByFriends(pubkey).size,
      overmuted: graphConsidersUserOvermuted(this.graph, pubkey),
    } : { followDistance: 1000, friendsFollowing: 0, overmuted: false }
    if (this.signalCache.size < 4096) this.signalCache.set(pubkey, signals)
    return signals
  }

  candidates(limit = 512, maxDistance = 3): string[] {
    if (!this.graph) return []
    limit = Math.min(2048, Math.max(0, Math.floor(limit)))
    maxDistance = Math.min(3, Math.max(1, Math.floor(maxDistance)))
    const cacheKey = `${limit}:${maxDistance}`
    const cached = this.candidateCache.get(cacheKey)
    if (cached) return cached
    const candidates: string[] = []
    for (let distance = 1; distance <= maxDistance && candidates.length < limit; distance++) {
      const level = [...this.graph.getUsersByFollowDistance(distance)]
        .map(key => ({ key, ...this.signals(key) }))
        .filter(person => !person.overmuted)
        .sort((a, b) => b.friendsFollowing - a.friendsFollowing || a.key.localeCompare(b.key))
      candidates.push(...level.slice(0, limit - candidates.length).map(person => person.key))
    }
    this.candidateCache.set(cacheKey, candidates)
    return candidates
  }

  private async persist() {
    // Closing during hydration must not replace the saved graph with a partial snapshot.
    if (!this.state.ownerPubkey || !this.state.ready) return
    const owner = this.state.ownerPubkey
    let bytes = 0
    const events = [...this.events.values()].reverse().filter(event => {
      bytes += JSON.stringify(event).length
      return bytes <= MAX_CACHE_BYTES
    })
    await this.options.saveEvents(owner, events).catch(() => {})
  }

  stop() {
    void this.persist()
    this.generation++
    clearTimeout(this.refreshTimer)
    clearTimeout(this.saveTimer)
    this.refreshTimer = undefined
    this.saveTimer = undefined
    for (const stop of this.stops) stop()
    this.stops.clear()
    this.hydrating = false
    this.discoveryEdge = false
    this.graph = null
    this.events.clear()
    this.queried.clear()
    this.knownFollows.clear()
    this.signalCache.clear()
    this.candidateCache.clear()
    this.state = { ownerPubkey: null, ready: false, version: this.state.version }
    this.emit()
  }
}

const state = writable<PeopleGraphState>({ ownerPubkey: null, ready: false, version: 0 })
export const peopleGraph = { subscribe: state.subscribe }
const cache = new Dexie('iris-chat-people-graph')
cache.version(1).stores({ accounts: 'owner' })
let seed: Promise<Uint8Array> | undefined
function loadSeed(): Promise<Uint8Array> {
  return seed ??= (async () => {
    const url = (await import('nostr-social-graph/data/socialGraph.bin?url')).default
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) })
    if (!response.ok) throw new Error('People graph seed unavailable')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > 4 * 1024 * 1024) throw new Error('People graph seed exceeds limit')
    return bytes
  })()
}

const controller = new PeopleGraphController({
  loadGraph: async owner => SocialGraph.fromBinary(owner, await loadSeed()),
  loadEvents: async owner => (await cache.table('accounts').get(owner))?.events ?? [],
  saveEvents: async (owner, events) => { await cache.table('accounts').put({ owner, events }) },
  changed: next => state.set(next),
  subscribe: (authors, onEvent, done) => {
    const sub = asNdkEventSubscription(get(ndk).subscribe(
      { kinds: [3, 10000], authors, limit: authors.length * 2 }, { closeOnEose: false },
    ))
    sub.on('event', event => onEvent(event.rawEvent() as Event))
    sub.on('eose', done)
    sub.on('close', done)
    return () => sub.stop()
  },
})

let clients = 0
let cleanup: (() => void) | undefined
export function initPeopleGraph(): () => void {
  if (++clients === 1) {
    const stopIdentity = identity.subscribe(id => {
      const loading = controller.setOwner(id?.pubkey ?? null)
      controller.setFollowingHead(get(followingHead))
      void loading.then(() => {
        controller.setFollowingHead(get(followingHead))
        controller.setFollowing(get(following))
      })
    })
    const stopFollowing = following.subscribe(keys => controller.setFollowing(keys))
    const stopFollowingHead = followingHead.subscribe(event => controller.setFollowingHead(event))
    cleanup = () => { stopIdentity(); stopFollowing(); stopFollowingHead(); controller.stop() }
  }
  let active = true
  return () => {
    if (!active) return
    active = false
    if (--clients === 0) { cleanup?.(); cleanup = undefined }
  }
}
export const getPeopleGraphSignals = (pubkey: string) => controller.signals(pubkey)
export const isOvermuted = (pubkey: string) => controller.signals(pubkey).overmuted
export const getPeopleGraphCandidates = (limit = 512, maxDistance = 3) => controller.candidates(limit, maxDistance)

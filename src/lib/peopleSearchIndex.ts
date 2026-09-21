import { HashTree, LinkType, fromHex, nhashDecode, toHex, type CID, type Store, type TreeEntry } from '@hashtree/core'
import { sha256 } from '@noble/hashes/sha2.js'
import { nip19, verifyEvent, type Event } from 'nostr-tools'
import type { PeopleSubscribe } from './messagingPeople'
import type { Profile } from './profile'
import { peopleSearchScore } from './peopleSearch'
import { createNostrSubscribe } from './profileAppKeysRuntime'

// Same public profile index and recovery snapshot used by Iris native.
const INDEX_OWNER = nip19.decode('npub1dhuna75xx06lj4v4gkf9klgklrem9ez82h9u9zpxd77usm73pcdqctllwf').data as string
const SNAPSHOT = 'nhash1qqsdspyk9j47vfde5w6lgjqftp2uuzw6wqptkwyuvlg8w7lh7dn370c9yr8hastd4k5cf49de7nfvtqu0t3v8mqn339fywyz4hafp66pspfx78z5lgs'
const SERVERS = ['https://cdn.iris.to', 'https://hashtree.iris.to']
const MAX_BLOB_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 8 * MAX_BLOB_BYTES
const MAX_RESULTS = 64
const HEX_KEY = /^[0-9a-f]{64}$/
const decoder = new TextDecoder()

interface SearchOptions {
  signal: AbortSignal
  onProfiles: (profiles: Profile[]) => void
  onProfileUpdate?: (profile: Profile) => void
}
interface IndexOptions {
  root: CID
  owner?: string
  subscribe: () => PeopleSubscribe
  fetch?: typeof fetch
  servers?: string[]
}
type CachedProfile = { profile: Profile; createdAt: number }

function subscribeUntilDone(subscribe: PeopleSubscribe, filter: Parameters<PeopleSubscribe>[0],
  signal: AbortSignal, receive: (event: Event) => void, timeout = 1800): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    let stop: (() => void) | undefined
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      stop?.()
      resolve()
    }
    const timer = setTimeout(finish, timeout)
    signal.addEventListener('abort', finish, { once: true })
    try {
      stop = subscribe(filter, event => {
        if (!done && !signal.aborted) receive(event as Event)
      }, finish)
      if (done) stop()
    } catch { finish() }
  })
}

function verifiedEvent(value: unknown): Event | undefined {
  if (!value || typeof value !== 'object') return
  const event = value as Event
  try {
    if (typeof event.content !== 'string' || event.content.length > 16384 ||
        !Number.isSafeInteger(event.created_at) || event.created_at < 0 ||
        event.created_at > Date.now() / 1000 + 300 || !Array.isArray(event.tags) ||
        event.tags.length > 64 || event.tags.some(tag => !Array.isArray(tag) || tag.length > 8 ||
          tag.some(value => typeof value !== 'string' || value.length > 2048)) ||
        !HEX_KEY.test(event.pubkey) || !verifyEvent(event)) return
    return event
  } catch { return }
}

function parseProfile(value: unknown, owner: string): CachedProfile | undefined {
  const event = verifiedEvent(value)
  if (!event || event.kind !== 0 || event.pubkey !== owner) return
  try {
    const data = JSON.parse(event.content)
    if (!data || typeof data !== 'object' || Array.isArray(data)) return
    const profile: Profile = { pubkey: owner, eventCreatedAt: event.created_at }
    for (const field of ['name', 'display_name', 'username', 'nip05', 'picture'] as const) {
      if (typeof data[field] === 'string') profile[field] = data[field].slice(0, field === 'picture' ? 2048 : 256)
    }
    return { profile, createdAt: event.created_at }
  } catch { return }
}

function rootFromEvent(value: unknown, owner: string): CID | undefined {
  const event = verifiedEvent(value)
  if (!event || event.pubkey !== owner || ![30064, 30078].includes(event.kind) ||
      !event.tags.some(tag => tag[0] === 'd' && tag[1] === 'profile-search')) return
  const tag = (name: string) => event.tags.find(tag => tag[0] === name)?.[1]
  if (tag('encryptedKey') || tag('selfEncryptedKey')) return
  try {
    const legacy = tag('hash') ? {} : JSON.parse(event.content)
    const hash = tag('hash') ?? legacy.hash
    const key = tag('key') ?? legacy.key
    if (!HEX_KEY.test(hash) || (key !== undefined && !HEX_KEY.test(key)) ||
        (legacy.visibility && legacy.visibility !== 'public')) return
    return { hash: fromHex(hash), ...(key ? { key: fromHex(key) } : {}) }
  } catch { return }
}

const unescapeKey = (key: string) => key.replace(/%2F/gi, '/').replace(/%00/gi, '\0').replace(/%25/g, '%')

// Read only the B-tree branches intersecting a term's prefix. The read budget
// also bounds malformed trees; cycle detection and depth bounds stop recursion.
async function* prefixEntries(tree: HashTree, root: CID, prefix: string, signal: AbortSignal,
  visited = new Set<string>(), depth = 0): AsyncGenerator<TreeEntry> {
  signal.throwIfAborted()
  const id = toHex(root.hash)
  if (depth > 12 || visited.has(id)) return
  visited.add(id)
  const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
  const entries = (await tree.listDirectory(root, signal)).filter(entry => entry.name.length <= 1024)
    .sort((a, b) => unescapeKey(a.name) < unescapeKey(b.name) ? -1 : unescapeKey(a.name) > unescapeKey(b.name) ? 1 : 0)
  const leaf = entries.some(entry => entry.type !== LinkType.Dir)
  for (let i = 0; i < entries.length; i++) {
    signal.throwIfAborted()
    const entry = entries[i]
    const name = unescapeKey(entry.name)
    if (name >= end) break
    if (leaf) {
      if (entry.type !== LinkType.Dir && name.startsWith(prefix)) yield { ...entry, name }
    } else if (i === entries.length - 1 || unescapeKey(entries[i + 1].name) > prefix) {
      yield* prefixEntries(tree, entry.cid, prefix, signal, visited, depth + 1)
    }
  }
}

export function createPeopleIndexSearch(options: IndexOptions) {
  let currentRoot = options.root
  let rootUpdatedAt = -1
  let lastRootLookup = -Infinity
  const profiles = new Map<string, CachedProfile>()
  const blocks = new Map<string, Uint8Array>()
  let blockBytes = 0
  const fetchBlob = options.fetch ?? fetch
  const servers = options.servers ?? SERVERS
  const indexOwner = options.owner ?? INDEX_OWNER

  return async (rawQuery: string, { signal: callerSignal, onProfiles, onProfileUpdate }: SearchOptions): Promise<void> => {
    const query = rawQuery.trim().toLowerCase()
    if (callerSignal.aborted || query.length < 2 || query.length > 128) return
    const terms = [...new Set(query.split(/[^\p{L}\p{N}]+/u).filter(term => term.length >= 2))].slice(0, 8)
    if (!terms.length) return
    const matches = (profile: Profile) => peopleSearchScore(profile, query, { followDistance: 999, friendsFollowing: 0 }) > -Infinity
    const results = new Map([...profiles].filter(([, cached]) => matches(cached.profile)).map(([owner, cached]) => [owner, cached.profile]))
    if (results.size) onProfiles([...results.values()])
    if (callerSignal.aborted) return
    const controller = new AbortController()
    const signal = controller.signal
    const abort = () => controller.abort()
    callerSignal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(abort, 6000)
    let reads = 0
    let bytes = 0
    const account = (amount: number) => {
      bytes += amount
      if (bytes > MAX_TOTAL_BYTES) throw new Error('Profile index byte budget exceeded')
    }
    const store: Store = {
      put: async () => { throw new Error('Read-only profile index') },
      delete: async () => { throw new Error('Read-only profile index') },
      has: async hash => !!await store.get(hash),
      get: async hash => {
        signal.throwIfAborted()
        if (++reads > 256) throw new Error('Profile index read budget exceeded')
        const id = toHex(hash)
        const cached = blocks.get(id)
        if (cached) { account(cached.length); return cached }
        for (const server of servers) {
          signal.throwIfAborted()
          try {
            const response = await fetchBlob(`${server}/${id}.bin`, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) })
            if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_BLOB_BYTES) {
              await response.body?.cancel()
              continue
            }
            const reader = response.body.getReader()
            const chunks: Uint8Array[] = []
            let size = 0
            try {
              for (;;) {
                const chunk = await reader.read()
                if (chunk.done) break
                account(chunk.value.length)
                size += chunk.value.length
                if (size > MAX_BLOB_BYTES) throw new Error('Profile index blob is too large')
                chunks.push(chunk.value)
              }
            } finally { await reader.cancel() }
            const data = new Uint8Array(size)
            let offset = 0
            for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length }
            if (toHex(sha256(data)) !== id) continue
            while (blockBytes + size > MAX_TOTAL_BYTES || blocks.size >= 256) {
              const oldest = blocks.keys().next().value
              if (!oldest) break
              blockBytes -= blocks.get(oldest)!.length
              blocks.delete(oldest)
            }
            blocks.set(id, data)
            blockBytes += size
            return data
          } catch {
            if (signal.aborted || bytes > MAX_TOTAL_BYTES) throw new Error('Profile search stopped')
          }
        }
        throw new Error('Profile index blob unavailable')
      },
    }
    const tree = new HashTree({ store })
    const subscribe = options.subscribe()
    const accept = (value: unknown, owner: string) => {
      if (signal.aborted || callerSignal.aborted) return
      const next = parseProfile(value, owner)
      if (!next || next.createdAt < (profiles.get(owner)?.createdAt ?? -1)) return
      profiles.set(owner, next)
      if (profiles.size > 512) profiles.delete(profiles.keys().next().value!)
      onProfileUpdate?.(next.profile)
      if (matches(next.profile)) results.set(owner, next.profile)
      else results.delete(owner)
      onProfiles([...results.values()].slice(0, MAX_RESULTS))
    }
    const searchedRoots = new Set<string>()
    let completedRoots = 0
    const search = async (root: CID) => {
      const hash = toHex(root.hash)
      if (searchedRoots.has(hash) || signal.aborted) return
      searchedRoots.add(hash)
      const candidates = new Map<string, TreeEntry>()
      for (const term of terms) {
        let count = 0
        for await (const entry of prefixEntries(tree, root, `p:${term}`, signal)) {
          const owner = entry.name.slice(entry.name.lastIndexOf(':') + 1)
          if (HEX_KEY.test(owner) && candidates.size < MAX_RESULTS) candidates.set(owner, entry)
          if (++count >= 128) break
        }
      }
      completedRoots++
      const entries = [...candidates]
      // Relay metadata streams alongside archive hydration, including older
      // key-only index formats. Index-provided names are never authenticated.
      const metadata = entries.length ? subscribeUntilDone(subscribe,
        { kinds: [0], authors: entries.map(([owner]) => owner), limit: 128 }, signal,
        event => { if (candidates.has(event.pubkey)) accept(event, event.pubkey) }) : Promise.resolve()
      let next = 0
      const hydrate = async () => {
        while (next < entries.length && !signal.aborted) {
          const [owner, entry] = entries[next++]
          try {
            if (entry.size > 32768) continue
            const data = await tree.readFile(entry.cid, { maxBytes: 32768 })
            if (!data) continue
            const record = JSON.parse(decoder.decode(data))
            if (record?.kind === 0) accept(record, owner)
            else if (typeof record?.event_nhash === 'string' && record.event_nhash.length <= 256 &&
                     (record.pubkey === undefined || record.pubkey === owner)) {
              const event = await tree.readFile(nhashDecode(record.event_nhash), { maxBytes: 32768 })
              if (event) accept(JSON.parse(decoder.decode(event)), owner)
            }
          } catch { /* Missing and malformed records must not suppress other hits. */ }
        }
      }
      await Promise.all([metadata, ...Array.from({ length: Math.min(4, entries.length) }, hydrate)])
    }
    try {
      const root = currentRoot
      // A cold lookup can use the pinned snapshot immediately. Root discovery
      // refreshes it concurrently and warm queries reuse verified blocks.
      const refresh = Date.now() - lastRootLookup > 60000
        ? (() => {
          lastRootLookup = Date.now()
          return subscribeUntilDone(subscribe, { kinds: [30064, 30078], authors: [indexOwner], '#d': ['profile-search'], limit: 2 }, signal, event => {
            const resolved = rootFromEvent(event, indexOwner)
            if (resolved && event.created_at > rootUpdatedAt) { currentRoot = resolved; rootUpdatedAt = event.created_at }
          }, 1500).then(() => {
            if (signal.aborted) { lastRootLookup = -Infinity; return }
            return search(currentRoot)
          })
        })() : Promise.resolve()
      await Promise.allSettled([search(root), refresh])
      if (!completedRoots && !callerSignal.aborted) throw new Error('People search index is unavailable')
    } finally {
      controller.abort()
      clearTimeout(timeout)
      callerSignal.removeEventListener('abort', abort)
    }
  }
}

let search: ReturnType<typeof createPeopleIndexSearch> | undefined
export function searchPeopleIndex(query: string, options: SearchOptions): Promise<void> {
  search ??= createPeopleIndexSearch({ root: nhashDecode(SNAPSHOT), subscribe: createNostrSubscribe })
  return search(query, options)
}

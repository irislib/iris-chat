// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HashTree, LinkType, MemoryStore, fromHex, nhashEncode, toHex, type TreeEntry } from '@hashtree/core'
import { finalizeEvent, generateSecretKey, getPublicKey, type VerifiedEvent } from 'nostr-tools'
import type { PeopleSubscribe } from './messagingPeople'
import type { Profile } from './profile'

vi.mock('./profileAppKeysRuntime', () => ({ createNostrSubscribe: vi.fn() }))
import { createPeopleIndexSearch } from './peopleSearchIndex'

const encoder = new TextEncoder()
const secret = generateSecretKey()
const owner = getPublicKey(secret)
function metadata(name: string, key = secret, created_at = 100): VerifiedEvent {
  return finalizeEvent({ kind: 0, created_at, tags: [], content: JSON.stringify({ name }) }, key)
}
async function fixture(records: Array<{ key: string; value: unknown }>) {
  const store = new MemoryStore()
  const tree = new HashTree({ store })
  const entries = await Promise.all(records.map(async ({ key, value }) => {
    const { cid, size } = await tree.putFile(encoder.encode(JSON.stringify(value)))
    return { name: key, cid, size, type: LinkType.Blob }
  }))
  const { cid: root } = await tree.putDirectory(entries)
  const fetched: string[] = []
  const fetchBlob = vi.fn(async (input: string | URL | Request) => {
    const hash = String(input).split('/').at(-1)!.replace('.bin', '')
    fetched.push(hash)
    const bytes = await store.get(fromHex(hash))
    return bytes ? new Response(bytes as BodyInit) : new Response(null, { status: 404 })
  }) as unknown as typeof fetch
  return { store, tree, entries, root, fetchBlob, fetched }
}
function subscriptions(events: VerifiedEvent[] = []) {
  const stopped = vi.fn()
  const filters: Array<Parameters<PeopleSubscribe>[0]> = []
  const subscribe: PeopleSubscribe = (filter, receive, eose) => {
    filters.push(filter)
    queueMicrotask(() => {
      for (const event of events) if (filter.kinds?.includes(event.kind)) receive(event)
      eose?.()
    })
    return stopped
  }
  return { subscribe, stopped, filters }
}
afterEach(() => vi.useRealTimers())

describe('indexed people discovery', () => {
  it('reads real encrypted index branches and emits only matching owner-signed metadata', async () => {
    const valid = metadata('Alice')
    const badOwner = getPublicKey(generateSecretKey())
    const forged = { ...metadata('Alice forgery'), sig: '0'.repeat(128) }
    const f = await fixture([
      { key: `p:alice:${owner}`, value: valid },
      { key: `p:alice:${badOwner}`, value: valid },
      { key: `p:alice:${getPublicKey(generateSecretKey())}`, value: forged },
      { key: `p:alice:${getPublicKey(generateSecretKey())}`, value: { pubkey: owner, name: 'Alice index hint' } },
    ])
    const irrelevant = await f.tree.putDirectory([{ ...f.entries[0], name: 'p:zebra:unused' }])
    const branch: TreeEntry = { name: 'p:zebra:', cid: irrelevant.cid, size: 1, type: LinkType.Dir }
    const root = (await f.tree.putDirectory([{ name: 'p:alice:', cid: f.root, size: 4, type: LinkType.Dir }, branch])).cid
    const { subscribe } = subscriptions()
    const search = createPeopleIndexSearch({ root, fetch: f.fetchBlob, subscribe: () => subscribe, servers: ['https://index.test'] })
    const batches: Profile[][] = []
    await search('alice', { signal: new AbortController().signal, onProfiles: batch => batches.push(batch) })
    expect(batches.at(-1)).toEqual([{ pubkey: owner, name: 'Alice', eventCreatedAt: 100 }])
    expect(f.fetched).not.toContain(toHex(irrelevant.cid.hash))
    expect(batches.flat().every(profile => profile.pubkey === owner)).toBe(true)
  })

  it('hydrates signed event links and shows warm cached results before any network wait', async () => {
    const f = await fixture([])
    const event = await f.tree.putFile(encoder.encode(JSON.stringify(metadata('Alice'))))
    const record = await f.tree.putFile(encoder.encode(JSON.stringify({ pubkey: owner, name: 'Untrusted label', event_nhash: nhashEncode(event.cid) })))
    const root = (await f.tree.putDirectory([{ name: `p:alice:${owner}`, ...record, type: LinkType.Blob }])).cid
    const { subscribe } = subscriptions()
    const search = createPeopleIndexSearch({ root, fetch: f.fetchBlob, subscribe: () => subscribe, servers: ['https://index.test'] })
    const initial = vi.fn()
    await search('alice', { signal: new AbortController().signal, onProfiles: initial })
    expect(initial).toHaveBeenLastCalledWith([{ pubkey: owner, name: 'Alice', eventCreatedAt: 100 }])
    const reads = f.fetched.length
    const cached = vi.fn()
    const result = search('alice', { signal: new AbortController().signal, onProfiles: cached })
    expect(cached).toHaveBeenCalledWith([{ pubkey: owner, name: 'Alice', eventCreatedAt: 100 }])
    await result
    expect(f.fetched.length).toBe(reads)
  })

  it('uses batched signed relay metadata for key-only records and rejects stale names', async () => {
    const f = await fixture([{ key: `p:alice:${owner}`, value: { name: 'Alice hint' } }])
    const { subscribe, filters } = subscriptions([metadata('Alice relay'), metadata('Mallory', secret, 101), metadata('Alice stale')])
    const search = createPeopleIndexSearch({ root: f.root, fetch: f.fetchBlob, subscribe: () => subscribe, servers: ['https://index.test'] })
    const results = vi.fn()
    const updates = vi.fn()
    await search('alice', { signal: new AbortController().signal, onProfiles: results, onProfileUpdate: updates })
    expect(filters.find(filter => filter.kinds?.includes(0))?.authors).toEqual([owner])
    expect(results).toHaveBeenLastCalledWith([])
    expect(updates).toHaveBeenLastCalledWith({ pubkey: owner, name: 'Mallory', eventCreatedAt: 101 })
  })

  it('resolves authenticated newer roots without waiting before the snapshot search', async () => {
    const f = await fixture([])
    const record = await f.tree.putFile(encoder.encode(JSON.stringify(metadata('Alice'))))
    const live = (await f.tree.putDirectory([{ name: `p:alice:${owner}`, ...record, type: LinkType.Blob }])).cid
    const rootEvent = finalizeEvent({ kind: 30064, created_at: 100, content: '', tags: [
      ['d', 'profile-search'], ['hash', toHex(live.hash)], ['key', toHex(live.key!)],
    ] }, secret)
    const { subscribe } = subscriptions([rootEvent])
    const search = createPeopleIndexSearch({ root: f.root, owner, fetch: f.fetchBlob, subscribe: () => subscribe, servers: ['https://index.test'] })
    const results = vi.fn()
    await search('alice', { signal: new AbortController().signal, onProfiles: results })
    expect(f.fetched[0]).toBe(toHex(f.root.hash))
    expect(results).toHaveBeenLastCalledWith([{ pubkey: owner, name: 'Alice', eventCreatedAt: 100 }])
  })

  it('aborts pending downloads and subscriptions without emitting stale results', async () => {
    const f = await fixture([{ key: `p:alice:${owner}`, value: metadata('Alice') }])
    const stopped = vi.fn()
    const subscribe: PeopleSubscribe = () => stopped
    let downloadSignal: AbortSignal | undefined
    const fetchBlob = vi.fn((_input: unknown, init?: RequestInit) => {
      downloadSignal = init?.signal as AbortSignal
      return new Promise<Response>((_resolve, reject) => downloadSignal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }))
    }) as unknown as typeof fetch
    const search = createPeopleIndexSearch({ root: f.root, fetch: fetchBlob, subscribe: () => subscribe, servers: ['https://index.test'] })
    const controller = new AbortController()
    const results = vi.fn()
    const pending = search('alice', { signal: controller.signal, onProfiles: results })
    await vi.waitFor(() => expect(downloadSignal).toBeDefined())
    controller.abort()
    await pending
    expect(downloadSignal?.aborted).toBe(true)
    expect(stopped).toHaveBeenCalledOnce()
    expect(results).not.toHaveBeenCalled()
  })

  it('closes in-flight owner metadata subscriptions and ignores callbacks after cancellation', async () => {
    const f = await fixture([{ key: `p:alice:${owner}`, value: { name: 'Alice hint' } }])
    const stopped = vi.fn()
    let receiveMetadata: Parameters<PeopleSubscribe>[1] | undefined
    const subscribe: PeopleSubscribe = (filter, receive) => {
      if (filter.kinds?.includes(0)) receiveMetadata = receive
      return stopped
    }
    const search = createPeopleIndexSearch({ root: f.root, fetch: f.fetchBlob, subscribe: () => subscribe, servers: ['https://index.test'] })
    const controller = new AbortController()
    const results = vi.fn()
    const pending = search('alice', { signal: controller.signal, onProfiles: results })
    await vi.waitFor(() => expect(receiveMetadata).toBeDefined())
    controller.abort()
    await pending
    receiveMetadata!(metadata('Alice'))
    expect(stopped).toHaveBeenCalledTimes(2)
    expect(results).not.toHaveBeenCalled()
  })

  it('rejects unavailable blobs and cancels oversized streamed bodies before parsing them', async () => {
    const f = await fixture([])
    const { subscribe } = subscriptions()
    const cancel = vi.fn()
    const fetchBlob = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024))
        controller.enqueue(new Uint8Array(1))
      }, cancel,
    }))) as unknown as typeof fetch
    const search = createPeopleIndexSearch({ root: f.root, fetch: fetchBlob, subscribe: () => subscribe, servers: ['https://index.test'] })
    await expect(search('alice', { signal: new AbortController().signal, onProfiles: vi.fn() })).rejects.toThrow('unavailable')
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetchBlob).toHaveBeenCalledOnce()
  })

  it('treats hash-mismatched data as unavailable and valid empty indexes as no results', async () => {
    const f = await fixture([])
    const { subscribe } = subscriptions()
    const onProfiles = vi.fn()
    const options = { root: f.root, subscribe: () => subscribe, servers: ['https://index.test'] }
    const invalid = createPeopleIndexSearch({ ...options, fetch: async () => new Response('forged index') })
    await expect(invalid('alice', { signal: new AbortController().signal, onProfiles })).rejects.toThrow('unavailable')
    const empty = createPeopleIndexSearch({ ...options, fetch: f.fetchBlob })
    await expect(empty('alice', { signal: new AbortController().signal, onProfiles })).resolves.toBeUndefined()
    expect(onProfiles).not.toHaveBeenCalled()
  })
})

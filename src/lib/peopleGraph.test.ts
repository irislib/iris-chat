import { describe, expect, it, vi } from 'vitest'
import { SocialGraph } from 'nostr-social-graph'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools'
import { writable } from 'svelte/store'

vi.mock('./identity', () => ({ identity: writable(null), nostrClient: writable(null) }))
vi.mock('./following', () => ({ following: writable(new Set()), followingHead: writable(null) }))

import { PeopleGraphController, graphConsidersUserOvermuted, DEFAULT_DISCOVERY_PUBKEY } from './peopleGraph'

const key = (n: string) => n.repeat(64)
const signed = (secret: Uint8Array, kind: number, targets: string[], created_at = 10) =>
  finalizeEvent({ kind, created_at, tags: targets.map(p => ['p', p]), content: '' }, secret)

describe('people graph search policy', () => {
  it('uses the nearest opinion bucket, keeps ties, and lets direct mutes override follows', async () => {
    const secret = generateSecretKey()
    const root = getPublicKey(secret)
    const friend = key('1'), muter = key('2'), target = key('3'), far = key('4')
    const graph = new SocialGraph(root)
    graph.addFollower(root, friend)
    graph.addFollower(root, muter)
    graph.addFollower(friend, target)
    graph.addFollower(friend, far)
    await graph.recalculateFollowDistances()
    graph.handleEvent({ id: '', sig: '', content: '', kind: 10000, pubkey: muter, created_at: 10, tags: [['p', target]] })
    expect(graphConsidersUserOvermuted(graph, target)).toBe(false)
    graph.handleEvent({ id: '', sig: '', content: '', kind: 10000, pubkey: far, created_at: 10, tags: [['p', target]] })
    expect(graphConsidersUserOvermuted(graph, target)).toBe(false)
    graph.removeFollower(friend, target)
    expect(graphConsidersUserOvermuted(graph, target)).toBe(true)
    graph.addFollower(root, target)
    expect(graphConsidersUserOvermuted(graph, target)).toBe(false)
    graph.handleEvent(signed(secret, 10000, [target, root]))
    expect(graphConsidersUserOvermuted(graph, target)).toBe(true)
    expect(graphConsidersUserOvermuted(graph, root)).toBe(false)
    expect(graphConsidersUserOvermuted(graph, key('9'))).toBe(false)
  })
})

function fixture(loadGraph = async (owner: string) => new SocialGraph(owner), bootstrap?: ConstructorParameters<typeof PeopleGraphController>[0]['bootstrap'], canBootstrap?: () => boolean) {
  const subscriptions: Array<{ authors: string[]; event: (event: Event) => void; stop: ReturnType<typeof vi.fn> }> = []
  const saved = new Map<string, Event[]>()
  const controller = new PeopleGraphController({
    loadGraph,
    bootstrap,
    canBootstrap,
    loadEvents: async owner => saved.get(owner) ?? [],
    saveEvents: async (owner, events) => { saved.set(owner, events) },
    subscribe: (authors, event, done) => {
      const stop = vi.fn()
      subscriptions.push({ authors, event, stop })
      queueMicrotask(done)
      return stop
    },
    changed: vi.fn(),
  })
  return { controller, subscriptions, saved }
}

describe('people graph runtime', () => {
  it('discards a ready snapshot when relay preferences change during the merge', async () => {
    const owner = getPublicKey(generateSecretKey()), old = key('4'), newer = key('5')
    let allowed = true, release!: () => void, entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const fresh = new SocialGraph(DEFAULT_DISCOVERY_PUBKEY); fresh.addFollower(DEFAULT_DISCOVERY_PUBKEY, newer)
    const merge = fresh.merge.bind(fresh)
    vi.spyOn(fresh, 'merge').mockImplementationOnce(async graph => { await merge(graph); entered(); await gate })
    const { controller } = fixture(async root => {
      const graph = new SocialGraph(root); graph.addFollower(DEFAULT_DISCOVERY_PUBKEY, old); return graph
    }, async () => fresh, () => allowed)
    await controller.setOwner(owner); await ready
    allowed = false; release()
    await Promise.resolve(); await Promise.resolve()
    expect(controller.candidates()).toContain(old)
    expect(controller.candidates()).not.toContain(newer)
    controller.stop()
  })

  it('makes embedded discovery ready before the network and replaces overlapping projected lists', async () => {
    const owner = getPublicKey(generateSecretKey()), person = key('4'), newer = key('5')
    let deliver!: (graph: SocialGraph | undefined) => void
    const embedded = new SocialGraph(owner)
    embedded.handleEvent({ kind: 3, pubkey: DEFAULT_DISCOVERY_PUBKEY, created_at: 10,
      id: 'a'.repeat(64), sig: '', content: '', tags: [['p', person]] }, true)
    embedded.markListIncomplete(DEFAULT_DISCOVERY_PUBKEY, 3)
    const { controller } = fixture(async () => embedded, () => new Promise(resolve => { deliver = resolve }))
    await controller.setOwner(owner)
    expect(controller.state.ready).toBe(true)
    expect(controller.candidates()).toContain(person)
    const fresh = new SocialGraph(DEFAULT_DISCOVERY_PUBKEY)
    fresh.handleEvent({ kind: 3, pubkey: DEFAULT_DISCOVERY_PUBKEY, created_at: 20,
      id: 'b'.repeat(64), sig: '', content: '', tags: [['p', newer]] }, true)
    fresh.markListIncomplete(DEFAULT_DISCOVERY_PUBKEY, 3)
    deliver(fresh)
    await vi.waitFor(() => expect(controller.candidates()).toContain(newer))
    expect(controller.candidates()).not.toContain(person)
    controller.stop()
  })

  it('preserves verified live follows and mutes arriving while a snapshot merge yields', async () => {
    const secret = generateSecretKey(), owner = getPublicKey(secret), friend = key('6'), muted = key('7')
    let deliver!: (graph: SocialGraph | undefined) => void
    const { controller, subscriptions } = fixture(undefined, () => new Promise(resolve => { deliver = resolve }))
    await controller.setOwner(owner)
    const fresh = new SocialGraph(DEFAULT_DISCOVERY_PUBKEY)
    let merging!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { merging = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const merge = fresh.merge.bind(fresh)
    vi.spyOn(fresh, 'merge').mockImplementationOnce(async graph => { await merge(graph); merging(); await gate })
    deliver(fresh); await started
    const subscription = subscriptions.find(value => value.authors.length === 1 && value.authors[0] === owner)!
    subscription.event(signed(secret, 3, [friend], 40))
    subscription.event(signed(secret, 10000, [muted], 41))
    release()
    await vi.waitFor(() => expect(fresh.getListRevision(owner, 10000)?.created_at).toBe(41))
    expect(controller.candidates()).toContain(friend)
    expect(controller.signals(muted).mutedByYou).toBe(true)
    expect(fresh.merge).toHaveBeenCalledTimes(2)
    controller.stop()
  })

  it('keeps embedded discovery after a rejected public snapshot and cancels it on identity change', async () => {
    const owner = getPublicKey(generateSecretKey()), person = key('4')
    const { controller } = fixture(async root => {
      const graph = new SocialGraph(root); graph.addFollower(DEFAULT_DISCOVERY_PUBKEY, person); return graph
    }, async () => { throw new Error('Malformed or underpopulated public snapshot') })
    await controller.setOwner(owner)
    await Promise.resolve()
    expect(controller.state.ready).toBe(true)
    expect(controller.candidates()).toContain(person)
    controller.stop()
    let request!: AbortSignal, deliver!: (graph: SocialGraph | undefined) => void
    const pending = fixture(undefined, (_graph, signal) => { request = signal; return new Promise(resolve => { deliver = resolve }) })
    await pending.controller.setOwner(owner)
    pending.controller.stop()
    expect(request.aborted).toBe(true)
    deliver(new SocialGraph(owner)); await Promise.resolve()
    expect(pending.controller.state.ownerPubkey).toBeNull()
  })

  it('offers Sirius immediately and uses the seed network for an account without follows', async () => {
    const owner = getPublicKey(generateSecretKey()), person = key('4')
    let resolveSeed!: (graph: SocialGraph) => void
    const { controller, saved } = fixture(() => new Promise(resolve => { resolveSeed = resolve }))
    const loading = controller.setOwner(owner)
    expect(controller.candidates()).toContain(DEFAULT_DISCOVERY_PUBKEY)
    const graph = new SocialGraph(owner)
    graph.addFollower(DEFAULT_DISCOVERY_PUBKEY, person)
    resolveSeed(graph)
    await loading
    expect(controller.candidates()).toContain(person)
    expect(controller.signals(person).followDistance).toBe(2)
    controller.stop()
    expect(saved.get(owner)).toEqual([])
  })

  it('replaces the discovery entry point with actual follows and restores it after unfollowing', async () => {
    const secret = generateSecretKey(), owner = getPublicKey(secret), person = key('4'), friend = key('6')
    const { controller } = fixture(async root => {
      const graph = new SocialGraph(root)
      graph.addFollower(DEFAULT_DISCOVERY_PUBKEY, person)
      return graph
    })
    await controller.setOwner(owner)
    controller.setFollowingHead(signed(secret, 3, [friend], 20))
    await controller.flush()
    expect(controller.candidates()).toEqual([friend])
    controller.setFollowingHead(signed(secret, 3, [], 21))
    await controller.flush()
    expect(controller.candidates()).toContain(person)
    controller.setFollowingHead(signed(secret, 3, [DEFAULT_DISCOVERY_PUBKEY], 22))
    await controller.flush()
    expect(controller.candidates()).toContain(person)
    controller.stop()
  })

  it('respects the empty account’s own mutes when using the discovery network', async () => {
    const secret = generateSecretKey(), owner = getPublicKey(secret), person = key('4')
    const { controller, saved } = fixture(async root => {
      const graph = new SocialGraph(root)
      graph.addFollower(DEFAULT_DISCOVERY_PUBKEY, person)
      return graph
    })
    saved.set(owner, [signed(secret, 3, []), signed(secret, 10000, [person])])
    await controller.setOwner(owner)
    expect(controller.signals(person).overmuted).toBe(true)
    expect(controller.candidates()).not.toContain(person)
    controller.stop()
  })

  it('replays signed account cache and rejects forged, stale, and unrelated live opinions', async () => {
    const rootSecret = generateSecretKey(), friendSecret = generateSecretKey()
    const owner = getPublicKey(rootSecret), friend = getPublicKey(friendSecret), target = key('3')
    const { controller, subscriptions, saved } = fixture()
    saved.set(owner, [signed(rootSecret, 3, [friend], 20), signed(friendSecret, 10000, [target], 20)])
    await controller.setOwner(owner)
    expect(controller.state.ready).toBe(true)
    expect(controller.signals(friend).followDistance).toBe(1)
    expect(controller.signals(target).overmuted).toBe(true)
    const rootSub = subscriptions.find(sub => sub.authors.length === 1 && sub.authors[0] === owner)!
    rootSub.event({ ...signed(rootSecret, 10000, [friend], 21), content: 'forged' })
    rootSub.event(signed(friendSecret, 3, [key('5')], 21))
    rootSub.event(signed(rootSecret, 3, [], 19))
    await controller.flush()
    expect(controller.signals(friend)).toMatchObject({ followDistance: 1, overmuted: false })
    expect(controller.candidates()).toContain(friend)
    controller.stop()
  })

  it('keeps a delayed previous-account graph and callback out of the active account', async () => {
    const oldSecret = generateSecretKey(), nextSecret = generateSecretKey()
    const oldOwner = getPublicKey(oldSecret), nextOwner = getPublicKey(nextSecret)
    let resolveOld!: (graph: SocialGraph) => void
    const { controller, subscriptions } = fixture(owner => owner === oldOwner
      ? new Promise(resolve => { resolveOld = resolve })
      : Promise.resolve(new SocialGraph(owner)))
    const oldLoad = controller.setOwner(oldOwner)
    const oldSubscription = subscriptions[0]
    await controller.setOwner(nextOwner)
    oldSubscription.event(signed(oldSecret, 3, [key('8')]))
    resolveOld(new SocialGraph(oldOwner))
    await oldLoad
    expect(controller.state.ownerPubkey).toBe(nextOwner)
    expect(oldSubscription.stop).toHaveBeenCalled()
    expect(controller.candidates()).not.toContain(key('8'))
    const current = subscriptions.find(sub => sub.authors[0] === nextOwner)!
    await controller.setOwner(null)
    current.event(signed(nextSecret, 3, [key('8')]))
    expect(controller.state.ownerPubkey).toBeNull()
    expect(controller.candidates()).toEqual([])
  })

  it('reopens the same account with a fresh graph and subscriptions', async () => {
    const secret = generateSecretKey(), owner = getPublicKey(secret)
    const { controller, saved, subscriptions } = fixture()
    saved.set(owner, [signed(secret, 3, [key('7')])])
    await controller.setOwner(owner)
    expect(controller.candidates()).toContain(key('7'))
    controller.stop()
    expect(controller.state).toMatchObject({ ownerPubkey: null, ready: false })
    const count = subscriptions.length
    await controller.setOwner(owner)
    expect(controller.state).toMatchObject({ ownerPubkey: owner, ready: true })
    expect(controller.candidates()).toContain(key('7'))
    expect(subscriptions.length).toBeGreaterThan(count)
    controller.stop()
  })

  it('keeps live root opinions that arrive before the seed finishes loading', async () => {
    const secret = generateSecretKey(), owner = getPublicKey(secret)
    let resolveSeed!: (graph: SocialGraph) => void
    const { controller, subscriptions } = fixture(() => new Promise(resolve => { resolveSeed = resolve }))
    const loading = controller.setOwner(owner)
    subscriptions[0].event(signed(secret, 3, [key('6')]))
    subscriptions[0].event(signed(secret, 10000, [key('5')]))
    resolveSeed(new SocialGraph(owner))
    await loading
    expect(controller.candidates()).toContain(key('6'))
    expect(controller.signals(key('5')).overmuted).toBe(true)
    controller.stop()
  })

  it('preserves the account cache when closed before hydration finishes', async () => {
    const secret = generateSecretKey(), owner = getPublicKey(secret)
    let resolveSeed!: (graph: SocialGraph) => void
    const { controller, saved } = fixture(() => new Promise(resolve => { resolveSeed = resolve }))
    const cached = [signed(secret, 3, [key('6')])]
    saved.set(owner, cached)
    const loading = controller.setOwner(owner)
    controller.stop()
    resolveSeed(new SocialGraph(owner))
    await loading
    expect(saved.get(owner)).toEqual(cached)
  })

  it('uses the verified cached contact head for ranking and friend opinions while relays are offline', async () => {
    const rootSecret = generateSecretKey(), friendSecret = generateSecretKey()
    const owner = getPublicKey(rootSecret), friend = getPublicKey(friendSecret), target = key('6')
    let resolveSeed!: (graph: SocialGraph) => void
    const { controller, saved } = fixture(() => new Promise(resolve => { resolveSeed = resolve }))
    saved.set(owner, [signed(friendSecret, 10000, [target], 20)])
    const loading = controller.setOwner(owner)
    controller.setFollowingHead(signed(rootSecret, 3, [friend], 20))
    resolveSeed(new SocialGraph(owner))
    await loading
    expect(controller.signals(friend).followDistance).toBe(1)
    expect(controller.signals(target).overmuted).toBe(true)
    controller.setFollowingHead({ ...signed(rootSecret, 3, [], 21), content: 'forged' })
    controller.setFollowingHead(signed(friendSecret, 3, [], 21))
    await controller.flush()
    expect(controller.signals(friend).followDistance).toBe(1)
    controller.setFollowingHead(signed(rootSecret, 3, [], 22))
    await controller.flush()
    expect(controller.signals(friend).followDistance).toBe(1000)
    expect(controller.signals(target).overmuted).toBe(false)
    controller.stop()
  })
})


it('persists a catch-up graph and cancels a late catch-up handle on account switch', async () => {
  const first = getPublicKey(generateSecretKey()), second = getPublicKey(generateSecretKey())
  const saved = new Map<string, Uint8Array>()
  const stops: Array<ReturnType<typeof vi.fn>> = []
  const completions: Array<() => void> = []
  const controller = new PeopleGraphController({
    loadGraph: async owner => saved.has(owner) ? SocialGraph.fromBinary(owner, saved.get(owner)!) : new SocialGraph(owner),
    loadEvents: async () => [], saveEvents: async () => {},
    saveGraph: async (owner, graph) => { saved.set(owner, await graph.toBinary()) },
    subscribe: (_authors, _event, done) => { queueMicrotask(done); return () => {} },
    changed: () => {},
    catchup: async (getGraph, changed) => {
      const graph = getGraph()
      graph.addFollower(graph.getRoot(), key('7'))
      changed()
      const stop = vi.fn(); stops.push(stop)
      return new Promise(resolve => completions.push(() => resolve(stop)))
    },
  })
  await controller.setOwner(first)
  await controller.flush()
  await controller.setOwner(second)
  completions[0]()
  await Promise.resolve()
  await Promise.resolve()
  expect(stops[0]).toHaveBeenCalledOnce()
  // Saving the previous account must never capture the new account's graph.
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(saved.has(first)).toBe(true)
  const recovered = await SocialGraph.fromBinary(first, saved.get(first)!)
  expect(recovered.isFollowing(first, key('7'))).toBe(true)
  expect(recovered.isFollowing(second, key('7'))).toBe(false)
  completions[1]()
  controller.stop()
})

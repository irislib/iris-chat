import { describe, expect, it, vi } from 'vitest'
import { SocialGraph } from 'nostr-social-graph'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools'
import { writable } from 'svelte/store'

vi.mock('./identity', () => ({ identity: writable(null), ndk: writable(null) }))
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

function fixture(loadGraph = async (owner: string) => new SocialGraph(owner)) {
  const subscriptions: Array<{ authors: string[]; event: (event: Event) => void; stop: ReturnType<typeof vi.fn> }> = []
  const saved = new Map<string, Event[]>()
  const controller = new PeopleGraphController({
    loadGraph,
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

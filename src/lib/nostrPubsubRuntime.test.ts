// @vitest-environment node
import 'fake-indexeddb/auto'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Segment, type FipsServiceContext } from '@fips/tcp'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'
import { Invite, Session } from 'nostr-double-ratchet'
import type {
  FipsPubsubClientNode,
} from 'nostr-pubsub'

import { NostrPubsubRuntime as SharedMesh } from './nostrPubsubRuntime'
import { createNostrRuntime, FipsPubsubWireCodec, type NostrFilter, type NostrEvent } from 'nostr-pubsub'
import { createNostrWorkerRuntime, MESSAGE_AUTHOR_REQUEST_BYTES } from './nostrWorkerRuntime'
import { RecordReader } from './deviceSyncTcp'
import { TestRelay } from '../../e2e/test-relay'

const runtimes: ReturnType<typeof createNostrRuntime>[] = []
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.close())) })

// Exercise Chat's adapter through the real common runtime rather than a second app-owned bus.
class NostrPubsubRuntime extends SharedMesh {
  readonly events = createNostrRuntime({ websocketImplementation: WebSocket as unknown as typeof globalThis.WebSocket, relays: [], batchWindowMs: 1, historyTimeoutMs: 100, publishTimeoutMs: 100,
    maxFilterBytesPerBatch: MESSAGE_AUTHOR_REQUEST_BYTES })
  constructor() { super(); runtimes.push(this.events) }
  activate(node: FipsPubsubClientNode, peer: string, peers: () => readonly string[], _runtime?: unknown, _announcements?: unknown,
    pairwiseCarriers?: (ids: string[]) => Promise<ReadonlySet<string>>) {
    return super.activate(node, peer, peers, this.events, undefined, pairwiseCarriers)
  }
  subscribe(filter: NostrFilter, onEvent: (event: NostrEvent) => void) {
    const subscription = this.events.subscribe([filter], { onEvent })
    return () => subscription.close()
  }
  async publish(event: NostrEvent) { return this.events.publish(event, { queue: false }) }
}

const PEER_A = `02${'11'.repeat(32)}`
const PEER_B = `03${'22'.repeat(32)}`
const PEER_C = `02${'33'.repeat(32)}`
type FipsPubsubServiceHandler = (context: FipsServiceContext) => Promise<void> | void

class MemoryFipsNetwork {
  private readonly nodes = new Map<string, MemoryFipsNode>()
  readonly packets: Array<{ from: string; to: string; payload: Uint8Array }> = []

  node(peerId: string): MemoryFipsNode {
    const node = new MemoryFipsNode(peerId, this)
    this.nodes.set(peerId, node)
    return node
  }

  get(peerId: string): MemoryFipsNode | undefined {
    return this.nodes.get(peerId) ?? [...this.nodes.values()].find(node => node.id.slice(2) === peerId.slice(2))
  }

  messages() {
    const streams = new Map<string, { from: string; to: string; segments: Map<number, Uint8Array> }>()
    for (const packet of this.packets) {
      const segment = Segment.decode(packet.payload)
      if (!segment.payload.length) continue
      const key = `${packet.from}:${packet.to}:${segment.srcPort}:${segment.dstPort}`
      const stream = streams.get(key) ?? { from: packet.from, to: packet.to, segments: new Map() }
      streams.set(key, stream)
      stream.segments.set(segment.seq, segment.payload)
    }
    const codec = new FipsPubsubWireCodec()
    return [...streams.values()].flatMap(stream => {
      const reader = new RecordReader(65_525)
      return [...stream.segments].sort(([left], [right]) => left - right).flatMap(([, bytes]) =>
        reader.push(bytes).map(frame => ({ from: stream.from, to: stream.to, message: codec.decodeFrame(frame) })))
    })
  }
}

class MemoryFipsNode implements FipsPubsubClientNode {
  private readonly services = new Map<number, FipsPubsubServiceHandler>()
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor(readonly id: string, private readonly network: MemoryFipsNetwork) {}

  registerService(port: number, handler: FipsPubsubServiceHandler): () => void {
    this.services.set(port, handler)
    return () => {
      if (this.services.get(port) === handler) this.services.delete(port)
    }
  }

  on(event: 'peer' | 'session', listener: (event: unknown) => void): () => void {
    let listeners = this.listeners.get(event)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(event, listeners)
    }
    listeners.add(listener)
    return () => listeners?.delete(listener)
  }

  async sendDatagram(args: {
    dst: string
    srcPort?: number
    dstPort: number
    payload: Uint8Array
  }): Promise<void> {
    const target = this.network.get(args.dst)
    if (!target) throw new Error(`unroutable FIPS peer ${args.dst}`)
    this.network.packets.push({ from: this.id, to: args.dst, payload: args.payload.slice() })
    queueMicrotask(() => void target.receive({
      src: this.id,
      srcPort: args.srcPort ?? 0,
      dstPort: args.dstPort,
      payload: new Uint8Array(args.payload),
    }).catch(() => undefined))
  }

  async receive(context: FipsServiceContext): Promise<void> {
    const handler = this.services.get(context.dstPort)
    if (!handler) throw new Error(`no FIPS service on ${context.dstPort}`)
    await handler(context)
  }
}

async function settle(runtimes: NostrPubsubRuntime[], predicate: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Promise.all(runtimes.map((runtime) => runtime.idle()))
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (predicate()) return
  }
  throw new Error('pubsub runtimes did not settle')
}

function chatEvent(createdAt: number, content: string) {
  return finalizeEvent({
    kind: 1060,
    created_at: createdAt,
    tags: [['p', 'b'.repeat(64)]],
    content,
  }, generateSecretKey())
}

describe('NostrPubsubRuntime', () => {
  it('keeps provider interests and private publication on trusted sibling streams only', async () => {
    const network = new MemoryFipsNetwork()
    const secret = generateSecretKey(), owner = getPublicKey(secret)
    const peerOwner = getPublicKey(generateSecretKey()), peerDevice = getPublicKey(generateSecretKey())
    const worker = createNostrWorkerRuntime(owner, async (_relay, event) => finalizeEvent(event, secret))
    const local = new SharedMesh(), sibling = new NostrPubsubRuntime(), contact = new NostrPubsubRuntime()
    const relay = new TestRelay()
    relay.authRequired = true
    await relay.start()
    worker.setRelays([relay.url])
    const stops: Array<() => void> = []
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await local.activate(network.node(PEER_A), PEER_A, () => [PEER_B], worker)
      await sibling.activate(network.node(PEER_B), PEER_B, () => [PEER_A])
      // An accepted contact may share the live endpoint, but cannot read its message service.
      await contact.activate(network.node(PEER_C), PEER_C, () => [PEER_A])
      stops.push(contact.subscribe({ kinds: [1060] }, () => {}))
      const ownInvite = Invite.createNew(owner, owner)
      const receiving = worker.subscribe([{ kinds: [1059], '#p': [ownInvite.inviterEphemeralPublicKey] }], { onEvent() {} })
      stops.push(() => receiving.close())
      const received = vi.fn()
      // A message names no recipient: the sibling follows the sender's ratchet key.
      const session = Session.init(getPublicKey(generateSecretKey()), generateSecretKey(), true, generateSecretKey())
      stops.push(sibling.subscribe({ kinds: [1060], authors: [session.state.ourCurrentNostrKey!.publicKey] }, received))
      const pump = async () => {
        await Promise.all([local.idle(), sibling.idle(), contact.idle()])
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      for (let turn = 0; turn < 8; turn++) await pump()
      await worker.query([{ kinds: [0, 37368], authors: [owner, peerOwner] }], {
        cache: 'network-only', deadline: Date.now() + 2000,
      })
      const sealed = session.sendEvent({ kind: 14, content: 'private fixture' }).event
      expect(sealed.tags.map(tag => tag[0])).toEqual(['v', 'header'])
      await expect(worker.publish(sealed, { relays: [], sources: ['fips'], queue: false })).rejects.toThrow('Group messages must use private sessions')
      const publication = await worker.publish(sealed, { relays: [], sources: ['fips'], queue: false, carrier: 'pairwise' })
      expect(publication.sources).toContainEqual({ id: 'fips', accepted: false, queued: true })
      for (let turn = 0; turn < 20 && !received.mock.calls.length; turn++) await pump()
      expect(received).toHaveBeenCalledTimes(1)
      expect(network.packets.some(packet => packet.from === PEER_C && packet.to === PEER_A)).toBe(true)
      expect(network.packets.some(packet => packet.from === PEER_A && packet.to === PEER_C)).toBe(false)
      const sent = network.messages().filter(frame => frame.from === PEER_A)
      expect(sent.length).toBeGreaterThan(0)
      expect(sent.every(frame => frame.to === `02${PEER_B.slice(2)}`)).toBe(true)
      expect(network.packets.some(packet => packet.from === PEER_B)).toBe(true)
      const requests = sent.flatMap(frame => frame.message.type === 'req' ? frame.message.filters : [])
      expect(requests).toContainEqual(expect.objectContaining({ kinds: [1059], '#p': [ownInvite.inviterEphemeralPublicKey] }))
      expect(requests.every(filter => !filter.kinds?.some(kind => [0, 30078, 37368].includes(kind)))).toBe(true)
      expect(JSON.stringify(requests)).not.toContain(peerOwner)
      expect(JSON.stringify(sent)).not.toContain(peerDevice)
      expect(sent.some(frame => frame.message.type === 'event' && frame.message.event.id === sealed.id)).toBe(true)
    } finally {
      stops.forEach(stop => stop())
      await Promise.all([local.deactivate(), sibling.deactivate(), contact.deactivate()])
      await worker.close()
      await relay.stop()
      warning.mockRestore()
    }
  })

  it('replays cached message envelopes to own devices only when a private session produced them', async () => {
    const network = new MemoryFipsNetwork()
    const alice = new NostrPubsubRuntime(), bob = new NostrPubsubRuntime()
    const seal = (content: string) => {
      const session = Session.init(getPublicKey(generateSecretKey()), generateSecretKey(), true, generateSecretKey())
      return session.sendEvent({ kind: 14, content }).event
    }
    const carrier = seal('pairwise carrier'), lost = seal('carrier whose record was trimmed')
    // Shared group ciphertext is signed by a sender key and has the very same tags.
    const sharedGroup = finalizeEvent({ kind: 1060, created_at: carrier.created_at, content: 'shared group ciphertext',
      tags: [['v', '2'], ['header', 'opaque']] }, generateSecretKey())
    const tagged = finalizeEvent({ kind: 1060, created_at: carrier.created_at, content: carrier.content,
      tags: [...carrier.tags, ['p', getPublicKey(generateSecretKey())]] }, generateSecretKey())
    const cached = [carrier, lost, sharedGroup, tagged]
    for (const event of cached) await alice.events.store.put(event)
    const asked: string[][] = []
    const received = vi.fn()
    try {
      // The durable outbox vouches by id; a recipient tag is refused even then.
      await alice.activate(network.node(PEER_A), PEER_A, () => [PEER_B], undefined, undefined, async ids => {
        asked.push(ids)
        return new Set([carrier.id, tagged.id])
      })
      await bob.activate(network.node(PEER_B), PEER_B, () => [PEER_A])
      bob.subscribe({ kinds: [1060], authors: cached.map(event => event.pubkey) }, received)
      await settle([alice, bob], () => received.mock.calls.length === 1)
      await settle([alice, bob], () => true)
      expect(received.mock.calls.map(([event]: [NostrEvent]) => event.id)).toEqual([carrier.id])
      expect(asked.length).toBeGreaterThan(0)
      expect(new Set(asked.flat())).toEqual(new Set(cached.map(event => event.id)))
      const replayed = network.messages().filter(frame => frame.from === PEER_A && frame.message.type === 'event')
        .map(frame => (frame.message as { event: NostrEvent }).event.id)
      expect(new Set(replayed)).toEqual(new Set([carrier.id]))
    } finally {
      await Promise.all([alice.deactivate(), bob.deactivate()])
    }
    // With no record at all, nothing of this kind leaves the cache.
    const silent = new NostrPubsubRuntime(), listener = new NostrPubsubRuntime()
    const none = vi.fn()
    const quiet = new MemoryFipsNetwork()
    for (const event of cached) await silent.events.store.put(event)
    try {
      await silent.activate(quiet.node(PEER_A), PEER_A, () => [PEER_B])
      await listener.activate(quiet.node(PEER_B), PEER_B, () => [PEER_A])
      listener.subscribe({ kinds: [1060], authors: cached.map(event => event.pubkey) }, none)
      for (let turn = 0; turn < 5; turn++) await settle([silent, listener], () => true)
      expect(none).not.toHaveBeenCalled()
      expect(quiet.messages().some(frame => frame.from === PEER_A && frame.message.type === 'event')).toBe(false)
    } finally {
      await Promise.all([silent.deactivate(), listener.deactivate()])
    }
  })

  it.each(['before', 'after'])('carries 180 device interests added %s activation without mixing recipients', async (when: string) => {
    const network = new MemoryFipsNetwork()
    const alice = new NostrPubsubRuntime()
    const bob = new NostrPubsubRuntime()
    const bobNode = network.node(PEER_B)
    const keys = Array.from({ length: 180 }, () => generateSecretKey())
    const received = keys.map(() => vi.fn())
    await alice.activate(network.node(PEER_A), PEER_A, () => [PEER_B])
    try {
      if (when === 'after') await bob.activate(bobNode, PEER_B, () => [PEER_A])
      const stops = keys.map((key, index) => bob.subscribe(
        { kinds: [1060], authors: [getPublicKey(key)] }, received[index]!,
      ))
      const otherRecipient = vi.fn()
      bob.subscribe({ kinds: [1060], authors: [getPublicKey(keys[0]!)], '#p': ['c'.repeat(64)] }, otherRecipient)
      if (when === 'before') await bob.activate(bobNode, PEER_B, () => [PEER_A])
      await settle([alice, bob], () => true)
      const send = (index: number, content: string) => alice.publish(finalizeEvent({
        kind: 1060, created_at: 1_700_000_000, tags: [], content,
      }, keys[index]!))
      await send(0, 'first device')
      await send(179, 'last device')
      await settle([alice, bob], () => received[0]!.mock.calls.length === 1 && received[179]!.mock.calls.length === 1)
      expect(received.slice(1, -1).every((handler) => handler.mock.calls.length === 0)).toBe(true)

      // Shared interests must not reduce each author's cached catch-up to the
      // carrier's default eight-event budget across the entire group.
      for (let index = 1; index <= 10; index++) await send(index, 'other device')
      await settle([alice, bob], () => received.slice(1, 11).every((handler) => handler.mock.calls.length === 1))
      const newListener = vi.fn()
      bob.subscribe({ kinds: [1060], authors: [getPublicKey(keys[179]!)] }, newListener)
      await settle([alice, bob], () => newListener.mock.calls.length === 1)
      expect(received[179]).toHaveBeenCalledTimes(1)

      stops[0]!()
      await settle([alice, bob], () => true)
      await send(0, 'closed interest')
      await send(179, 'remaining interest')
      await settle([alice, bob], () => received[179]!.mock.calls.length === 2)
      expect(received[0]).toHaveBeenCalledTimes(1)
      expect(otherRecipient).not.toHaveBeenCalled()

      await bob.deactivate()
      await bob.activate(bobNode, PEER_B, () => [PEER_A])
      await settle([alice, bob], () => true)
      await send(179, 'after mesh reconnect')
      await settle([alice, bob], () => received[179]!.mock.calls.length === 3)
    } finally {
      await bob.deactivate()
      await alice.deactivate()
    }
  })

  it('carries a full 1,000-author chunk as two parts, where one frame would carry nothing', async () => {
    const network = new MemoryFipsNetwork()
    const alice = new NostrPubsubRuntime(), bob = new NostrPubsubRuntime()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const keys = Array.from({ length: 2 }, () => generateSecretKey())
    const filler = (count: number) => Array.from({ length: count }, () => getPublicKey(generateSecretKey()))
    const whole = vi.fn(), parts = vi.fn()
    await alice.activate(network.node(PEER_A), PEER_A, () => [PEER_B])
    await bob.activate(network.node(PEER_B), PEER_B, () => [PEER_A])
    try {
      // One filter with every author exceeds the 65,525-byte frame and is dropped whole.
      bob.subscribe({ kinds: [1060], authors: [getPublicKey(keys[0]!), ...filler(999)] }, whole)
      bob.subscribe({ kinds: [1060], authors: [getPublicKey(keys[1]!), ...filler(499)] }, parts)
      bob.subscribe({ kinds: [1060], authors: filler(500) }, parts)
      await settle([alice, bob], () => true)
      for (const key of keys) await alice.publish(finalizeEvent({ kind: 1060, created_at: 1_700_000_010, tags: [], content: 'chunk' }, key))
      await settle([alice, bob], () => parts.mock.calls.length === 1)
      await settle([alice, bob], () => true)
      expect(whole).not.toHaveBeenCalled()
      expect(parts).toHaveBeenCalledTimes(1)
    } finally {
      await bob.deactivate()
      await alice.deactivate()
      warning.mockRestore()
    }
  })

  it('isolates an oversized mesh interest so other subscriptions and relays can start', async () => {
    const network = new MemoryFipsNetwork()
    const alice = new NostrPubsubRuntime()
    const bob = new NostrPubsubRuntime()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const received = vi.fn()
    await alice.activate(network.node(PEER_A), PEER_A, () => [PEER_B])
    await bob.activate(network.node(PEER_B), PEER_B, () => [PEER_A])
    try {
      expect(() => bob.subscribe({ '#x': ['x'.repeat(70_000)] }, () => {})).not.toThrow()
      bob.subscribe({ kinds: [1060] }, received)
      await settle([alice, bob], () => true)
      const event = chatEvent(1_700_000_005, 'healthy interest')
      await alice.publish(event)
      await settle([alice, bob], () => received.mock.calls.length === 1)
      expect(received).toHaveBeenCalledWith(expect.objectContaining({ id: event.id }), expect.anything())
    } finally {
      await bob.deactivate()
      await alice.deactivate()
      warning.mockRestore()
    }
  })

  it('reattaches subscriptions and carries matching signed events once', async () => {
    const network = new MemoryFipsNetwork()
    const alice = new NostrPubsubRuntime()
    const bob = new NostrPubsubRuntime()
    const aliceNode = network.node(PEER_A)
    const bobNode = network.node(PEER_B)
    const received = vi.fn()
    bob.subscribe({ kinds: [1060], '#p': ['b'.repeat(64)] }, received)
    await alice.activate(aliceNode, PEER_A, () => [PEER_B])
    await bob.activate(bobNode, PEER_B, () => [PEER_A])
    await settle([alice, bob], () => true)

    const event = chatEvent(1_700_000_000, 'shared authenticated carrier')
    await alice.publish(event)
    await settle([alice, bob], () => received.mock.calls.length === 1)
    await alice.publish(event)
    await settle([alice, bob], () => true)

    expect(received).toHaveBeenCalledTimes(1)
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ id: event.id }), expect.anything())
    await bob.deactivate()
    await alice.deactivate()
  })

  it('enforces kind admission and does not send after a peer closes its subscription', async () => {
    const network = new MemoryFipsNetwork()
    const alice = new NostrPubsubRuntime()
    const bob = new NostrPubsubRuntime()
    const aliceNode = network.node(PEER_A)
    const bobNode = network.node(PEER_B)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await alice.activate(aliceNode, PEER_A, () => [PEER_B])
    await bob.activate(bobNode, PEER_B, () => [PEER_A])
    const received = vi.fn()
    bob.subscribe({}, received)
    await settle([alice, bob], () => true)

    const profile = finalizeEvent({
      kind: 0,
      created_at: 1_700_000_001,
      tags: [],
      content: '{}',
    }, generateSecretKey())
    expect((await alice.publish(profile)).sources.find(source => source.id === 'fips')?.error).toMatch(/event kind 0/)

    await bob.deactivate()
    await settle([alice], () => true)
    await alice.publish(chatEvent(1_700_000_002, 'after close'))
    expect(received).not.toHaveBeenCalled()
    await alice.deactivate()
    warning.mockRestore()
  })

  it('serves account history to admitted devices and excludes other connected identities', async () => {
    const network = new MemoryFipsNetwork()
    const alice = new NostrPubsubRuntime(), bob = new NostrPubsubRuntime(), charlie = new NostrPubsubRuntime()
    const admitted = vi.fn(), stranger = vi.fn()
    alice.subscribe({ kinds: [1060] }, admitted)
    charlie.subscribe({ kinds: [1060] }, stranger)
    await bob.activate(network.node(PEER_B), PEER_B, () => [PEER_A])
    await alice.activate(network.node(PEER_A), PEER_A, () => [PEER_B])
    await charlie.activate(network.node(PEER_C), PEER_C, () => [PEER_B])
    try {
      await bob.publish(chatEvent(1_700_000_003, 'private account history'))
      await settle([alice, bob, charlie], () => admitted.mock.calls.length === 1)
      expect(stranger).not.toHaveBeenCalled()
    } finally {
      await Promise.all([alice.deactivate(), bob.deactivate(), charlie.deactivate()])
    }
  })
})

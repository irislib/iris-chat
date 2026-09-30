import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FipsServiceContext } from '@fips/tcp'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'
import type {
  FipsPubsubClientNode,
} from 'nostr-pubsub'

import { NostrPubsubRuntime as SharedMesh } from './nostrPubsubRuntime'
import { createNostrRuntime, type NostrFilter, type NostrEvent } from 'nostr-pubsub'

const runtimes: ReturnType<typeof createNostrRuntime>[] = []
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.close())) })

// Exercise Chat's adapter through the real common runtime rather than a second app-owned bus.
class NostrPubsubRuntime extends SharedMesh {
  readonly events = createNostrRuntime({ relays: [], batchWindowMs: 1, historyTimeoutMs: 100, publishTimeoutMs: 100 })
  constructor() { super(); runtimes.push(this.events) }
  activate(node: FipsPubsubClientNode, peer: string, peers: () => readonly string[]) {
    return super.activate(node, peer, peers, this.events)
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

  node(peerId: string): MemoryFipsNode {
    const node = new MemoryFipsNode(peerId, this)
    this.nodes.set(peerId, node)
    return node
  }

  get(peerId: string): MemoryFipsNode | undefined {
    return this.nodes.get(peerId)
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

import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools'
import type {
  FipsPubsubClientNode,
  FipsPubsubServiceContext,
  FipsPubsubServiceHandler,
} from 'nostr-pubsub'

import { NostrPubsubRuntime } from './nostrPubsubRuntime'

const PEER_A = `02${'11'.repeat(32)}`
const PEER_B = `03${'22'.repeat(32)}`
const PEER_C = `02${'33'.repeat(32)}`

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
    await target.receive({
      src: this.id,
      srcPort: args.srcPort ?? 0,
      dstPort: args.dstPort,
      payload: new Uint8Array(args.payload),
      reply: async (payload, destinationPort) => target.sendDatagram({
        dst: this.id,
        srcPort: args.dstPort,
        dstPort: destinationPort ?? args.srcPort ?? 0,
        payload,
      }),
    })
  }

  async receive(context: FipsPubsubServiceContext): Promise<void> {
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
  it('reattaches subscriptions and carries matching signed events once', async () => {
    const network = new MemoryFipsNetwork()
    const alice = new NostrPubsubRuntime()
    const bob = new NostrPubsubRuntime()
    const received = vi.fn()
    bob.subscribe({ kinds: [1060], '#p': ['b'.repeat(64)] }, received)
    await alice.activate(network.node(PEER_A), () => [PEER_B])
    await bob.activate(network.node(PEER_B), () => [PEER_A])
    await settle([alice, bob], () => true)

    const event = chatEvent(1_700_000_000, 'shared authenticated carrier')
    await alice.publish(event)
    await settle([alice, bob], () => received.mock.calls.length === 1)
    await alice.publish(event)
    await settle([alice, bob], () => true)

    expect(received).toHaveBeenCalledTimes(1)
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ id: event.id }))
    await bob.deactivate()
    await alice.deactivate()
  })

  it('enforces kind admission and treats a stopped peer as a send error', async () => {
    const network = new MemoryFipsNetwork()
    const alice = new NostrPubsubRuntime()
    const bob = new NostrPubsubRuntime()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await alice.activate(network.node(PEER_A), () => [PEER_B])
    await bob.activate(network.node(PEER_B), () => [PEER_A])
    const received = vi.fn()
    bob.subscribe({}, received)
    await settle([alice, bob], () => true)

    const profile = finalizeEvent({
      kind: 0,
      created_at: 1_700_000_001,
      tags: [],
      content: '{}',
    }, generateSecretKey())
    await expect(alice.publish(profile)).rejects.toThrow(/event kind 0/)

    await bob.deactivate()
    await settle([alice], () => true)
    await expect(alice.publish(chatEvent(1_700_000_002, 'after close')))
      .rejects.toThrow(/all FIPS pubsub deliveries failed/)
    expect(received).not.toHaveBeenCalled()
    await alice.deactivate()
    warning.mockRestore()
  })

  it('drops signed traffic from connected but non-admitted FIPS identities', async () => {
    const network = new MemoryFipsNetwork()
    const bob = new NostrPubsubRuntime()
    const charlie = new NostrPubsubRuntime()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await bob.activate(network.node(PEER_B), () => [PEER_A])
    await charlie.activate(network.node(PEER_C), () => [PEER_B])
    const received = vi.fn()
    bob.subscribe({ kinds: [1060] }, received)
    await settle([bob, charlie], () => true)

    await charlie.publish(chatEvent(1_700_000_003, 'valid but not admitted'))
    await settle([bob, charlie], () => true)
    expect(received).not.toHaveBeenCalled()
    expect(warning).toHaveBeenCalledWith(
      '[nostrPubsub] receive failed:',
      expect.any(Error),
    )
    await bob.deactivate()
    await charlie.deactivate()
    warning.mockRestore()
  })
})

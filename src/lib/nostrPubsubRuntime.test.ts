import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools'

import { NostrPubsubRuntime } from './nostrPubsubRuntime'

const PEER_A = `02${'11'.repeat(32)}`
const PEER_B = `03${'22'.repeat(32)}`
const PEER_C = `02${'33'.repeat(32)}`

class MemoryFipsNetwork {
  private readonly endpoints = new Map<string, ReturnType<MemoryFipsNetwork['endpoint']>>()

  endpoint(peerId: string) {
    const listeners = new Set<(event: unknown) => void>()
    const endpoint = {
      sendEndpointData: async ({ dst, payload }: { dst: string; payload: Uint8Array }) => {
        const target = this.endpoints.get(dst)
        if (!target) throw new Error(`unroutable peer ${dst}`)
        target.receive({ src: peerId, dst, payload: new Uint8Array(payload) })
      },
      on: (_event: 'endpointData', listener: (event: unknown) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      receive: (event: unknown) => {
        for (const listener of listeners) listener(event)
      },
    }
    this.endpoints.set(peerId, endpoint)
    return endpoint
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

describe('NostrPubsubRuntime', () => {
  it('propagates verified matching Nostr events and deduplicates replay', async () => {
    const network = new MemoryFipsNetwork()
    const alice = new NostrPubsubRuntime()
    const bob = new NostrPubsubRuntime()
    alice.activate(network.endpoint(PEER_A), () => [PEER_B])
    bob.activate(network.endpoint(PEER_B), () => [PEER_A])
    const received = vi.fn()
    bob.subscribe({ kinds: [1060], '#p': ['b'.repeat(64)] }, received)
    const event = finalizeEvent({
      kind: 1060,
      created_at: 1_700_000_000,
      tags: [['p', 'b'.repeat(64)]],
      content: 'encrypted chat envelope',
    }, generateSecretKey())

    await alice.publish(event)
    await settle([alice, bob], () => received.mock.calls.length === 1)
    await alice.publish(event)
    await settle([alice, bob], () => true)

    expect(received).toHaveBeenCalledTimes(1)
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ id: event.id }))
    alice.deactivate()
    bob.deactivate()
  })

  it('enforces outer-kind admission and removes endpoint listeners on deactivate', async () => {
    const network = new MemoryFipsNetwork()
    const alice = new NostrPubsubRuntime()
    const bob = new NostrPubsubRuntime()
    alice.activate(network.endpoint(PEER_A), () => [PEER_B])
    bob.activate(network.endpoint(PEER_B), () => [PEER_A])
    const received = vi.fn()
    bob.subscribe({}, received)
    const profile = finalizeEvent({
      kind: 0,
      created_at: 1_700_000_001,
      tags: [],
      content: '{}',
    }, generateSecretKey())

    await expect(alice.publish(profile)).rejects.toThrow(/event kind 0/)
    bob.deactivate()
    const chat = finalizeEvent({
      kind: 1060,
      created_at: 1_700_000_002,
      tags: [],
      content: 'after close',
    }, generateSecretKey())
    await alice.publish(chat)
    await settle([alice], () => true)
    expect(received).not.toHaveBeenCalled()
    alice.deactivate()
  })

  it('drops signed traffic from connected but non-admitted FIPS identities', async () => {
    const network = new MemoryFipsNetwork()
    const bob = new NostrPubsubRuntime()
    const charlie = new NostrPubsubRuntime()
    bob.activate(network.endpoint(PEER_B), () => [PEER_A])
    charlie.activate(network.endpoint(PEER_C), () => [PEER_B])
    const received = vi.fn()
    bob.subscribe({ kinds: [1060] }, received)
    const event = finalizeEvent({
      kind: 1060,
      created_at: 1_700_000_003,
      tags: [],
      content: 'valid but not admitted',
    }, generateSecretKey())

    await charlie.publish(event)
    await settle([bob, charlie], () => true)
    expect(received).not.toHaveBeenCalled()
    bob.deactivate()
    charlie.deactivate()
  })
})

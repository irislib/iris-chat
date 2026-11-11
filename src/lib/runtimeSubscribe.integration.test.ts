// @vitest-environment node
import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { Session, buildMessageAuthorSubscriptionFilters } from 'nostr-double-ratchet'
import { TestRelay } from '../../e2e/test-relay'
import { createNostrWorkerRuntime } from './nostrWorkerRuntime'
import NostrClient from './nostrClient'
import { createRuntimeSubscribe } from './runtimeSubscribe'

it('keeps live message interests on the configured relays after connection changes', async () => {
  const first = new TestRelay(), second = new TestRelay()
  await Promise.all([first.start(), second.start()])
  const receiver = createNostrWorkerRuntime('subscription-receiver')
  const sender = createNostrWorkerRuntime('subscription-sender')
  const received: string[] = []
  let stop: (() => void) | undefined
  try {
    receiver.setRelays([first.url])
    // Exercise the production subscription adapter and event delivery without
    // a browser worker boundary. The connected-relay snapshot is only A.
    const client = Object.assign(Object.create(NostrClient.prototype), {
      runtime: receiver, pool: { connectedRelays: () => [{ url: first.url }] },
    }) as NostrClient
    stop = createRuntimeSubscribe(client)({ kinds: [1060] }, event => received.push(event.id))
    receiver.setRelays([second.url])
    sender.setRelays([second.url])
    const session = Session.init(getPublicKey(generateSecretKey()), generateSecretKey(), true, generateSecretKey())
    const message = session.sendEvent({ kind: 14, content: 'encrypted-live-reply' }).event
    await sender.publish(message, { requireAck: true, carrier: 'pairwise' })
    await expect.poll(() => received, { timeout: 1500 }).toContain(message.id)
  } finally {
    stop?.()
    await Promise.all([receiver.close(), sender.close()])
    await Promise.all([first.stop(), second.stop()])
  }
})

it('delivers through every message-author chunk the library opens, each inside the relay request bounds', async () => {
  const relay = new TestRelay()
  const requests: Array<{ kinds?: number[]; authors?: string[]; limit?: number }[]> = []
  relay.observeWire = message => { if (message[0] === 'REQ') requests.push(message.slice(2) as never) }
  await relay.start()
  const receiver = createNostrWorkerRuntime('chunk-receiver'), sender = createNostrWorkerRuntime('chunk-sender')
  const received: string[] = [], failures: unknown[] = []
  const warning = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { failures.push(args) })
  const stops: Array<() => void> = []
  try {
    receiver.setRelays([relay.url]); sender.setRelays([relay.url])
    const client = Object.assign(Object.create(NostrClient.prototype), {
      runtime: receiver, pool: { connectedRelays: () => [{ url: relay.url }] },
    }) as NostrClient
    const subscribe = createRuntimeSubscribe(client)
    // 2,400 sender ratchet keys: about 300 people with two devices each and four keys per device.
    const sessions = Array.from({ length: 3 }, () => Session.init(getPublicKey(generateSecretKey()), generateSecretKey(), true, generateSecretKey()))
    const live = sessions.map(session => session.state.ourCurrentNostrKey!.publicKey)
    const authors = [...live, ...Array.from({ length: 2397 }, () => getPublicKey(generateSecretKey()))]
    const plan = buildMessageAuthorSubscriptionFilters(authors)
    expect(plan.filters.length).toBeGreaterThan(2)
    expect(plan.dropped).toEqual([])
    for (const filter of plan.filters) stops.push(subscribe(filter, event => received.push(event.id)))
    await vi.waitFor(() => {
      const asked = new Set(requests.flat().filter(filter => filter.kinds?.includes(1060) && filter.limit === undefined).flatMap(filter => filter.authors ?? []))
      expect(asked.size).toBe(authors.length)
    }, { timeout: 5000 })
    // No request may exceed what relays accept: 131,072-byte frames, 2,047 items per filter.
    expect(requests.length).toBeGreaterThanOrEqual(plan.filters.length)
    for (const filters of requests) {
      expect(JSON.stringify(['REQ', 'subscription-id', ...filters]).length).toBeLessThan(131_072)
      for (const filter of filters) expect(filter.authors?.length ?? 0).toBeLessThanOrEqual(1000)
    }
    const messages = sessions.map((session, index) => session.sendEvent({ kind: 14, content: `chunk ${index}` }).event)
    for (const message of messages) await sender.publish(message, { requireAck: true, carrier: 'pairwise' })
    await expect.poll(() => [...received].sort(), { timeout: 3000 }).toEqual(messages.map(message => message.id).sort())
    expect(failures).toEqual([])
    // Replacing one chunk leaves the others alone and never re-merges them.
    const before = requests.length
    stops.shift()!()
    stops.unshift(subscribe(plan.filters[0]!, event => received.push(event.id)))
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(before), { timeout: 5000 })
    for (const filters of requests.slice(before)) {
      for (const filter of filters) expect(plan.filters[0]!.authors).toEqual(expect.arrayContaining(filter.authors ?? []))
    }
  } finally {
    for (const stop of stops) stop()
    warning.mockRestore()
    await Promise.all([receiver.close(), sender.close()])
    await relay.stop()
  }
})

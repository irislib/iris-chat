// @vitest-environment node
import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools'
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
    const message = finalizeEvent({ kind: 1060, created_at: Math.floor(Date.now() / 1000),
      tags: [], content: 'encrypted-live-reply' }, generateSecretKey())
    await sender.publish(message, { requireAck: true })
    await expect.poll(() => received, { timeout: 1500 }).toContain(message.id)
  } finally {
    stop?.()
    await Promise.all([receiver.close(), sender.close()])
    await Promise.all([first.stop(), second.stop()])
  }
})

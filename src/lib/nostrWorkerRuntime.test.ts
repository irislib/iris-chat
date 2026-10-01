// @vitest-environment node
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { HashtreeRuntimeEventStore } from '@hashtree/nostr-pubsub'
import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from 'nostr-tools'
import { TestRelay } from '../../e2e/test-relay'
import { createEventStore } from './eventStore'
import { createNostrWorkerRuntime } from './nostrWorkerRuntime'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('restarts the real worker queue without replaying old static call alerts or losing safe pending events', async () => {
  const relay = new TestRelay()
  await relay.start()
  cleanup.push(() => relay.stop())
  const key = generateSecretKey(), recipient = getPublicKey(generateSecretKey())
  const owner = getPublicKey(key)
  const now = Math.floor(Date.now() / 1000)
  const legacy = finalizeEvent({ kind: 21111, created_at: now, tags: [['p', recipient]],
    content: nip44.v2.encrypt(JSON.stringify({ v: 3, type: 'offer', call_id: 'old-call', video: true }),
      nip44.v2.utils.getConversationKey(key, recipient)) }, key)
  // The generic worker treats existing ratchet envelopes as opaque signed bytes.
  const sealed = finalizeEvent({ kind: 1060, created_at: now, tags: [['p', recipient]],
    content: 'opaque-existing-session-envelope' }, generateSecretKey())
  const wake = finalizeEvent({ kind: 21111, created_at: now, tags: [['p', recipient]],
    content: JSON.stringify({ type: 'call-wake', v: 2, events: [sealed] }) }, key)
  const publicPost = finalizeEvent({ kind: 1, created_at: now, tags: [], content: 'public queued post' }, key)
  const beforeRestart = createEventStore(owner)
  for (const event of [legacy, wake, publicPost, sealed]) {
    await beforeRestart.putPending({ event, attempts: 1, updatedAt: Date.now(), relays: [relay.url], sources: [] })
  }
  await beforeRestart.close()

  // This is the same factory used by nostrWorker.ts. setRelays automatically
  // starts the shared runtime retry against the persisted production store.
  const runtime = createNostrWorkerRuntime(owner)
  cleanup.push(() => runtime.close())
  runtime.setRelays([relay.url])
  await vi.waitFor(() => {
    const sent = new Set(relay.publishedEvents.map(event => event.id))
    expect(sent).toEqual(new Set([wake.id, publicPost.id, sealed.id]))
  }, { timeout: 5000 })
  await vi.waitFor(async () => expect(await runtime.store.listPending()).toEqual([]), { timeout: 5000 })
  // No guessed ciphertext or signed authorization is erased by this gate.
  const retained = await HashtreeRuntimeEventStore.prototype.listPending.call(runtime.store)
  expect(retained.map(entry => entry.event.id)).toEqual([legacy.id])

  await expect(runtime.publish(legacy, { relays: [relay.url], requireAck: true, queue: false }))
    .rejects.toThrow('Old call alerts cannot be resent')
  expect(relay.publishedEvents.some(event => event.id === legacy.id)).toBe(false)
})

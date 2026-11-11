// @vitest-environment node
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, type VerifiedEvent } from 'nostr-tools'
import { Group, InMemoryStorageAdapter, Session, isForbiddenGroupRelayEvent, isSharedGroupCiphertext } from 'nostr-double-ratchet'
import { HashtreeRuntimeEventStore } from '@hashtree/nostr-pubsub'
import { TestRelay } from '../../e2e/test-relay'
import { callWakeEvent } from './callPush'
import { createEventStore } from './eventStore'
import { createNostrWorkerRuntime } from './nostrWorkerRuntime'
import { canRetryWorkerPublication, namesNoRecipient } from './workerPublicationPolicy'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.resetModules() })

/** Real sender-key ciphertext from the library, and a real pairwise carrier beside it. */
async function fixtures() {
  const key = generateSecretKey(), owner = getPublicKey(key), member = getPublicKey(generateSecretKey())
  const group = new Group({ data: { id: 'shared-ciphertext', name: 'Friends', members: [owner, member], admins: [owner], createdAt: 100 },
    ourOwnerPubkey: owner, ourDevicePubkey: owner, storage: new InMemoryStorageAdapter() })
  const sent = await group.sendMessage('group text', { sendPairwise: async () => {}, publishOuter: async () => { throw new Error('never published') } })
  const outer = sent.outer as VerifiedEvent
  const carrier = Session.init(getPublicKey(generateSecretKey()), generateSecretKey(), true, generateSecretKey())
    .sendEvent({ kind: 14, content: 'pairwise text' }).event
  return { owner, member, outer, carrier }
}

it('has exactly the wire shape of a pairwise carrier, so no tag can tell them apart', async () => {
  const { outer, carrier } = await fixtures()
  expect(outer.kind).toBe(1060)
  expect(outer.tags.map(tag => tag[0])).toEqual(carrier.tags.map(tag => tag[0]))
  expect(namesNoRecipient(outer)).toBe(true)
  // Only the context that made it knows, and only until that context is gone.
  expect(isSharedGroupCiphertext(outer.id)).toBe(true)
  expect(isForbiddenGroupRelayEvent(outer)).toBe(true)
  expect(isForbiddenGroupRelayEvent(carrier)).toBe(false)
})

it('is refused by the ratchet outbox when sent, and left unsent by every retry after a reload', async () => {
  const { outer, carrier } = await fixtures()
  const { createRuntimePublish } = await import('./runtimePublish')
  const storage = new InMemoryStorageAdapter()
  const publish = vi.fn(async (_event: VerifiedEvent) => new Set([{ url: 'wss://relay.example' }]))
  const queue = createRuntimePublish({ storage, owner: 'owner', publish, onError: vi.fn(), onlineTarget: new EventTarget() })
  cleanup.push(() => queue.close())
  await expect(queue.enqueue(outer)).rejects.toThrow('Group messages must use private sessions')
  await expect(queue.publish(outer, 'inner', { groupId: 'shared-ciphertext' })).rejects.toThrow('Group messages must use private sessions')
  expect(await storage.list('')).toEqual([])
  expect(publish).not.toHaveBeenCalled()
  await queue.publish(carrier)
  expect(publish.mock.calls.map(([event]: [VerifiedEvent]) => event.id)).toEqual([carrier.id])
  queue.close()

  // A reload forgets which ids were group ciphertext. A row an older version
  // left behind is then indistinguishable, and nothing vouches for it.
  await storage.put('v1/runtime-outbox/owner/' + outer.id, { event: outer, innerEventId: 'inner', context: { groupId: 'shared-ciphertext' } })
  vi.resetModules()
  vi.doMock('nostr-double-ratchet', async (importOriginal: () => Promise<typeof import('nostr-double-ratchet')>) => ({
    ...await importOriginal(), isSharedGroupCiphertext: () => false,
  }))
  cleanup.push(() => vi.doUnmock('nostr-double-ratchet'))
  expect((await import('nostr-double-ratchet')).isSharedGroupCiphertext(outer.id)).toBe(false)
  const reloaded = await import('./runtimePublish')
  const forgetful = reloaded.createRuntimePublish({ storage: new InMemoryStorageAdapter(), owner: 'other', publish, onError: vi.fn(), onlineTarget: new EventTarget() })
  cleanup.push(() => forgetful.close())
  // Proof the reloaded queue no longer recognises it by memory alone.
  await expect(forgetful.enqueue(outer)).resolves.toBeUndefined()
  const onError = vi.fn(), onlineTarget = new EventTarget()
  const replay = vi.fn(async (_event: VerifiedEvent) => new Set([{ url: 'wss://relay.example' }]))
  const restarted = reloaded.createRuntimePublish({ storage, owner: 'owner', publish: replay, onError, onlineTarget, retryIntervalMs: 1000 })
  cleanup.push(() => restarted.close())
  restarted.start()
  for (let attempt = 0; attempt < 3; attempt++) {
    onlineTarget.dispatchEvent(new Event('online'))
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(replay).not.toHaveBeenCalled()
  expect(onError).not.toHaveBeenCalled()
  expect(await storage.get('v1/runtime-outbox/owner/' + outer.id)).toBeTruthy()
  expect(await reloaded.pairwiseCarrierIds(storage, 'owner', [outer.id, carrier.id])).toEqual(new Set([carrier.id]))
})

it('is refused by the worker on direct sends, inside a call alert, and from its retry queue after a restart', async () => {
  const { owner, member, outer, carrier } = await fixtures()
  const relay = new TestRelay()
  await relay.start(); cleanup.push(() => relay.stop())
  // Queued before the restart: nothing recorded that a private session produced it.
  const alert = callWakeEvent(member, outer)
  const lane = createEventStore(`${owner}:private-send`, 'private')
  for (const event of [outer, alert, carrier]) {
    await lane.putPending({ event, attempts: 1, updatedAt: Date.now(), relays: [relay.url], sources: [] })
  }
  await lane.vouchPending(carrier.id, 'pairwise')
  await lane.close()
  expect(canRetryWorkerPublication(outer)).toBe(false)
  expect(canRetryWorkerPublication(alert)).toBe(false)

  const runtime = createNostrWorkerRuntime(owner)
  cleanup.push(() => runtime.close())
  runtime.setRelays([relay.url])
  await vi.waitFor(() => expect(relay.publishedEvents.map(event => event.id)).toEqual([carrier.id]), { timeout: 5000 })
  for (const options of [{}, { queue: true }, { queue: false }, { requireAck: true, queue: false }, { relays: [] as string[], sources: ['fips'] }]) {
    await expect(runtime.publish(outer, { relays: [relay.url], ...options })).rejects.toThrow('Group messages must use private sessions')
    await expect(runtime.publish(alert, { relays: [relay.url], ...options })).rejects.toThrow('Invalid encrypted call alert')
  }
  // Two more retry rounds of the private lane.
  await new Promise(resolve => setTimeout(resolve, 200))
  runtime.setRelays([relay.url])
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(relay.publishedEvents.map(event => event.id)).toEqual([carrier.id])
  expect(JSON.stringify(relay.publishedEvents)).not.toContain(outer.id)
  expect((await runtime.query([{ ids: [outer.id, alert.id] }], { cache: 'cache-only' })).events).toEqual([])
  // Kept locally, never offered for sending.
  const reopened = createEventStore(`${owner}:private-send`, 'private')
  expect(await reopened.listPending()).toEqual([])
  expect(new Set((await HashtreeRuntimeEventStore.prototype.listPending.call(reopened)).map(entry => entry.event.id)))
    .toEqual(new Set([outer.id, alert.id]))
  await reopened.close()
})

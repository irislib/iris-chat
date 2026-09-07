// @vitest-environment node
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VerifiedEvent } from 'nostr-tools'
import { db } from './storage'
import { DexieStorageAdapter } from './sessionManagerStorage'
import { createRuntimePublish, getPublishedRelayUrls } from './runtimePublish'

const waitFor = (assertion: () => void | Promise<void>) =>
  vi.waitFor(assertion, { interval: 1, timeout: 1000 })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const event = (id: string): VerifiedEvent =>
  ({
    id: id.repeat(64),
    pubkey: 'e'.repeat(64),
    created_at: 100,
    kind: 1060,
    tags: [['p', 'f'.repeat(64)]],
    content: `encrypted:${id}`,
    sig: id.repeat(128),
  }) as VerifiedEvent
const accepted = () => new Set([{ url: 'wss://relay.example' }])
const queues: ReturnType<typeof createRuntimePublish>[] = []
const storage = new DexieStorageAdapter()
const rows = async () => (await db.sessionManager.toArray()).map((row) => row.value)
const queueFor = (
  publish: Parameters<typeof createRuntimePublish>[0]['publish'],
  options: Partial<Parameters<typeof createRuntimePublish>[0]> = {}
) => {
  const queue = createRuntimePublish({
    owner: 'owner-a',
    storage,
    publish,
    onError: vi.fn(),
    ...options,
  })
  queues.push(queue)
  return queue
}

beforeEach(async () => {
  await db.sessionManager.clear()
})
afterEach(async () => {
  for (const queue of queues.splice(0)) queue.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
  await db.sessionManager.clear()
})

describe('durable runtime publication', () => {
  it('persists exact signed envelopes and lets a second send finish while an ACK never arrives', async () => {
    const stalled = deferred<ReturnType<typeof accepted>>()
    const publish = vi.fn(async (envelope: VerifiedEvent) =>
      envelope.id === event('a').id ? stalled.promise : accepted()
    )
    const onAcceptedRelays = vi.fn()
    const queue = queueFor(publish, { onAcceptedRelays })
    await queue.enqueue(event('a'), 'inner-a')
    expect(publish).not.toHaveBeenCalled()
    expect(await rows()).toEqual([{ event: event('a'), innerEventId: 'inner-a' }])

    void queue.publish(event('a'), 'inner-a').catch(() => {})
    await waitFor(() => expect(publish).toHaveBeenCalledOnce())
    await queue.enqueue(event('b'), 'inner-b')
    expect(await queue.publish(event('b'), 'inner-b')).toEqual(event('b'))
    expect(onAcceptedRelays).toHaveBeenCalledExactlyOnceWith('inner-b', [
      'wss://relay.example',
    ])
    expect(await rows()).toEqual([{ event: event('a'), innerEventId: 'inner-a' }])
  })

  it('rejects failed storage or unsigned input before dispatching', async () => {
    const publish = vi.fn(async () => accepted())
    const queue = queueFor(publish)
    await expect(queue.enqueue({ ...event('a'), sig: '' })).rejects.toThrow('unsigned')
    vi.spyOn(storage, 'put').mockRejectedValue(new Error('storage full'))
    await expect(queue.publish(event('a'), 'inner-a')).rejects.toThrow('storage full')
    expect(publish).not.toHaveBeenCalled()
    expect(await rows()).toEqual([])
  })

  it('retries zero-ACK failures unchanged after reopening storage, only for the owner', async () => {
    const onAcceptedRelays = vi.fn()
    const failed = queueFor(async () => new Set(), { onAcceptedRelays })
    const original = event('a')
    await expect(failed.publish(original, 'inner-a')).rejects.toThrow('not accepted')
    expect(onAcceptedRelays).not.toHaveBeenCalled()
    failed.close()
    db.close()
    await db.open()
    original.content = 'changed by caller'

    const otherPublish = vi.fn(async () => accepted())
    queueFor(otherPublish, { owner: 'owner-b' }).start()
    await storage.list('v1/runtime-outbox/owner-b/')
    expect(otherPublish).not.toHaveBeenCalled()

    const publish = vi.fn(async () => accepted())
    queueFor(publish, { storage: new DexieStorageAdapter(), onAcceptedRelays }).start()
    await waitFor(() => expect(publish).toHaveBeenCalledOnce())
    expect(publish.mock.calls[0]).toEqual([event('a'), expect.any(AbortSignal)])
    await waitFor(async () => expect(await rows()).toEqual([]))
    expect(onAcceptedRelays).toHaveBeenCalledExactlyOnceWith('inner-a', [
      'wss://relay.example',
    ])
  })

  it('deduplicates in-flight work and retains pending rows without sent status after close', async () => {
    const ack = deferred<ReturnType<typeof accepted>>()
    const publish = vi.fn(() => ack.promise)
    const onAcceptedRelays = vi.fn()
    const queue = queueFor(publish, { onAcceptedRelays })
    const first = queue.publish(event('a'), 'inner-a')
    const duplicate = queue.publish(event('a'), 'inner-a')
    const rejected = [first, duplicate].map((promise) =>
      expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    )
    await waitFor(() => expect(publish).toHaveBeenCalledOnce())
    queue.close()
    ack.resolve(accepted())
    await Promise.all(rejected)
    expect(onAcceptedRelays).not.toHaveBeenCalled()
    expect(await rows()).toHaveLength(1)
    await expect(queue.enqueue(event('b'))).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('retains rows when updating accepted-relay status fails', async () => {
    const queue = queueFor(async () => accepted(), {
      onAcceptedRelays: () => {
        throw new Error('status failed')
      },
    })
    await expect(queue.publish(event('a'), 'inner-a')).rejects.toThrow('status failed')
    expect(await rows()).toHaveLength(1)
  })

  it('retries on startup, online, and an interval and cleans up on close', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const onlineTarget = new EventTarget()
    const publish = vi.fn(async () => {
      throw new Error('offline')
    })
    const onError = vi.fn()
    const queue = queueFor(publish, { onError, onlineTarget, retryIntervalMs: 1000 })
    await queue.enqueue(event('a'), 'inner-a')
    queue.start()
    queue.start()
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    onlineTarget.dispatchEvent(new Event('online'))
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(1000)
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(3))
    queue.close()
    onlineTarget.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(vi.getTimerCount()).toBe(0)
    expect(publish).toHaveBeenCalledTimes(3)
  })

  it('extracts unique accepted relay URLs from NDK results', () => {
    expect(
      getPublishedRelayUrls(
        new Set([
          { url: 'wss://relay.one' },
          { relay: { url: 'wss://relay.two' } },
          { url: 'wss://relay.one' },
        ])
      )
    ).toEqual(['wss://relay.one', 'wss://relay.two'])
  })
})

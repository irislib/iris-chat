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
    expect(publish.mock.calls[0]).toEqual([event('a'), expect.any(AbortSignal), undefined])
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

  it('drops durable removed-group retries after restart while allowing direct messages and roster controls', async () => {
    const failed = queueFor(async () => new Set())
    await expect(failed.publish(event('a'), 'group-inner', { groupId: 'removed' })).rejects.toThrow('not accepted')
    await failed.enqueue(event('d'), 'queued-key-handoff', { groupId: 'removed' })
    await failed.enqueue(event('b'), 'direct-inner')
    await failed.enqueue(event('c'), 'roster-control')
    failed.close()
    db.close()
    await db.open()

    const publish = vi.fn(async (_event: VerifiedEvent) => accepted())
    const onAcceptedRelays = vi.fn()
    queueFor(publish, { canPublish: ({ groupId }) => groupId !== 'removed', onAcceptedRelays }).start()
    await waitFor(async () => expect(await rows()).toEqual([]))
    expect(publish.mock.calls.map(([sent]: [VerifiedEvent]) => sent.id).sort()).toEqual([event('b').id, event('c').id])
    expect(onAcceptedRelays).not.toHaveBeenCalledWith('group-inner', expect.anything())
  })

  it('retries durable work on a new relay connection without waiting for the interval', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let notify!: (urls: readonly string[]) => void
    let connected = false
    const unsubscribe = vi.fn()
    const publish = vi.fn(async () => {
      if (!connected) throw new Error('No connected message server')
      return accepted()
    })
    const queue = queueFor(publish, {
      subscribeConnected: listener => { notify = listener; listener([]); return unsubscribe },
    })
    queue.start()
    await expect(queue.publish(event('a'), 'private-unblock')).rejects.toThrow('No connected')
    expect(await rows()).toHaveLength(1)
    connected = true
    notify(['wss://relay.example'])
    await waitFor(async () => expect(await rows()).toEqual([]))
    expect(publish).toHaveBeenCalledTimes(2)
    notify(['wss://relay.example'])
    expect(publish).toHaveBeenCalledTimes(2)
    queue.close()
    expect(unsubscribe).toHaveBeenCalledOnce()
    notify(['wss://another.example'])
    expect(publish).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a connection wake-up that arrives while an offline attempt is settling', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let notify!: (urls: readonly string[]) => void
    const offline = deferred<void>()
    const publish = vi.fn(async () => {
      if (publish.mock.calls.length === 1) {
        await offline.promise
        throw new Error('offline attempt')
      }
      return accepted()
    })
    const queue = queueFor(publish, {
      subscribeConnected: listener => { notify = listener; return () => {} },
    })
    await queue.enqueue(event('a'), 'private-unblock')
    queue.start()
    await waitFor(() => expect(publish).toHaveBeenCalledOnce())
    notify(['wss://relay.example'])
    offline.resolve()
    await waitFor(async () => expect(await rows()).toEqual([]))
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('rechecks policy and owner scope when a relay connection wakes pending work', async () => {
    let notify!: (urls: readonly string[]) => void
    let allowed: boolean | 'hold' = 'hold'
    const other = queueFor(async () => accepted(), { owner: 'owner-b' })
    await other.enqueue(event('b'), 'other-owner')
    other.close()
    const publish = vi.fn(async () => accepted())
    const canPublish = vi.fn(() => allowed)
    const queue = queueFor(publish, {
      canPublish,
      subscribeConnected: listener => { notify = listener; return () => {} },
    })
    await queue.enqueue(event('a'), 'blocked-direct', { recipientOwnerPubkey: 'blocked' })
    queue.start()
    await waitFor(() => expect(canPublish).toHaveBeenCalledOnce())
    allowed = false
    notify(['wss://relay.example'])
    await waitFor(async () => expect(await rows()).toEqual([{ event: event('b'), innerEventId: 'other-owner' }]))
    expect(publish).not.toHaveBeenCalled()
  })

  it('aborts an in-flight group attempt and checks membership again before retrying', async () => {
    let member = true
    const onlineTarget = new EventTarget()
    const publish = vi.fn((_event: VerifiedEvent, signal: AbortSignal) => new Promise<ReturnType<typeof accepted>>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const onAcceptedRelays = vi.fn()
    const queue = queueFor(publish, { canPublish: () => member, onlineTarget, onAcceptedRelays })
    const pending = queue.publish(event('a'), 'inner', { groupId: 'removed' })
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await waitFor(() => expect(publish).toHaveBeenCalledOnce())
    member = false
    queue.cancelGroup('removed')
    await cancelled
    expect(onAcceptedRelays).not.toHaveBeenCalled()
    queue.start()
    await waitFor(async () => expect(await rows()).toEqual([]))
    expect(publish).toHaveBeenCalledOnce()
  })

  it('extracts unique accepted relay URLs from NostrClient results', () => {
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

 it('blocks legacy private payloads while other ciphertext drains, and requires exact authorization coverage before retirement', async () => {
  const blocked = { ...event('b'), kind: 37368, tags: [['d', 'devices'], ['device', 'new-device'], ['encrypted_device_labels', 'old-private-ciphertext']] }
  const key = 'v1/runtime-outbox/owner-a/' + blocked.id
  await storage.put(key, { event: blocked })
  const publish = vi.fn(async (_event: VerifiedEvent) => new Set([{ url: 'wss://relay.example' }]))
  const queue = queueFor(publish)
  queue.start()
  await queue.publish(event('a'))
  expect(publish.mock.calls.every(([item]: [VerifiedEvent]) => item.kind === 1060)).toBe(true)
  expect(await storage.get(key)).toEqual({ event: blocked })
  const changedAuthorization = { ...event('c'), kind: 37368, created_at: 101, tags: [['d', 'devices'], ['device', 'other-device']], content: blocked.content }
  await queue.publish(changedAuthorization)
  expect(await storage.get(key)).toEqual({ event: blocked })
  const replacement = { ...event('d'), kind: 37368, created_at: 101, tags: blocked.tags.filter(tag => tag[0] !== 'encrypted_device_labels'), content: blocked.content }
  publish.mockResolvedValueOnce(new Set())
  await expect(queue.publish(replacement)).rejects.toThrow('not accepted')
  expect(await storage.get(key)).toEqual({ event: blocked })
  await queue.publish(replacement)
  expect(await storage.get(key)).toBeUndefined()
 })
 it('never queues bare private controls or old self-encrypted contact records', async () => {
  const publish = vi.fn(async (_event: VerifiedEvent) => new Set([{ url: 'wss://relay.example' }]))
  const queue = queueFor(publish)
  for (const kind of [10449, 10450, 10451, 10452, 10453, 21112]) {
    await expect(queue.enqueue({ ...event('a'), kind })).rejects.toThrow('encrypted device queue')
  }
  await expect(queue.enqueue({ ...event('a'), kind: 30078, tags: [['t', 'nostr-social-memory/v1']] })).rejects.toThrow('encrypted device queue')
  expect(publish).not.toHaveBeenCalled()
 })

it('retires blocked direct retries and holds newer envelopes across restart without touching other recipients', async () => {
  const target = '1'.repeat(64), other = '2'.repeat(64)
  let blocked = true
  const canPublish = (context: import('nostr-double-ratchet').NostrPublishContext) => {
    if (context.recipientOwnerPubkey !== target) return true
    if (context.createdAt! <= 100) return false
    return blocked ? 'hold' as const : true
  }
  const old = queueFor(async () => accepted())
  await old.enqueue(event('a'), 'old', { recipientOwnerPubkey: target, createdAt: 90 })
  await old.enqueue(event('b'), 'new', { recipientOwnerPubkey: target, createdAt: 110 })
  await old.enqueue(event('c'), 'other', { recipientOwnerPubkey: other, createdAt: 90 })
  old.close()
  const publish = vi.fn(async () => accepted())
  const onlineTarget = new EventTarget()
  const queue = queueFor(publish, { canPublish, onlineTarget })
  queue.start()
  await waitFor(async () => expect(await rows()).toHaveLength(1))
  expect(publish.mock.calls).toEqual([[event('c'), expect.any(AbortSignal), { recipientOwnerPubkey: other, createdAt: 90 }]])
  blocked = false
  onlineTarget.dispatchEvent(new Event('online'))
  await waitFor(async () => expect(await rows()).toEqual([]))
  expect(publish).toHaveBeenCalledTimes(2)
})

it('aborts direct transport as soon as its block policy changes', async () => {
  const target = '1'.repeat(64)
  const publish = vi.fn((_event: VerifiedEvent, signal: AbortSignal) => new Promise<ReturnType<typeof accepted>>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const queue = queueFor(publish)
  const pending = queue.publish(event('a'), 'inner', { recipientOwnerPubkey: target, createdAt: 90 })
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await waitFor(() => expect(publish).toHaveBeenCalledOnce())
  queue.cancelDirect(target)
  await cancelled
  expect(await rows()).toHaveLength(1)
})

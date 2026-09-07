import type { StorageAdapter } from 'nostr-double-ratchet'
import { DexieStorageAdapter } from './sessionManagerStorage'
import type { VerifiedEvent } from 'nostr-tools'

interface PendingPublication {
  event: VerifiedEvent
  innerEventId?: string
}

interface RuntimePublishOptions {
  /** Public identity key whose outgoing envelopes this queue may publish. */
  owner: string
  publish: (event: VerifiedEvent, signal: AbortSignal) => Promise<RuntimePublishResult>
  onAcceptedRelays?: (
    innerEventId: string | undefined,
    relayUrls: string[]
  ) => void | Promise<void>
  onError: (error: unknown) => void
  storage?: StorageAdapter
  onlineTarget?: EventTarget
  retryIntervalMs?: number
}

export const createRuntimePublish = (options: RuntimePublishOptions) => {
  const storage = options.storage ?? new DexieStorageAdapter()
  const prefix = `v1/runtime-outbox/${options.owner}/`
  const controller = new AbortController()
  const { signal } = controller
  const enqueuing = new Map<string, Promise<void>>()
  const inFlight = new Map<string, Promise<VerifiedEvent | undefined>>()
  const onlineTarget =
    options.onlineTarget ?? (typeof window !== 'undefined' ? window : undefined)
  let timer: ReturnType<typeof setInterval> | undefined
  let started = false
  let scanning = false

  const enqueue = async (
    event: VerifiedEvent,
    innerEventId?: string
  ): Promise<void> => {
    signal.throwIfAborted()
    if (!event.id || !event.sig) throw new Error('Cannot queue an unsigned event')
    const key = prefix + event.id
    const pending = enqueuing.get(key)
    if (pending) return pending

    // Keep the signed envelope unchanged even if its caller later mutates it.
    const row: PendingPublication = { event: structuredClone(event), innerEventId }
    const writing = (async () => {
      const existing = await storage.get<PendingPublication>(key)
      signal.throwIfAborted()
      if (!existing) await storage.put(key, row)
      signal.throwIfAborted()
    })().finally(() => enqueuing.delete(key))
    enqueuing.set(key, writing)
    return writing
  }

  const attempt = (key: string): Promise<VerifiedEvent | undefined> => {
    const existing = inFlight.get(key)
    if (existing) return existing

    const publishing = (async () => {
      await enqueuing.get(key)
      signal.throwIfAborted()
      const row = await storage.get<PendingPublication>(key)
      signal.throwIfAborted()
      if (!row) return
      const accepted = await options.publish(row.event, signal)
      if (accepted.size === 0)
        throw new Error('Runtime event was not accepted by any relay')
      signal.throwIfAborted()
      await options.onAcceptedRelays?.(
        row.innerEventId,
        getPublishedRelayUrls(accepted)
      )
      // Keep retries until the ACK and host callback succeed for the active account.
      signal.throwIfAborted()
      await storage.del(key)
      return row.event
    })().finally(() => inFlight.delete(key))
    inFlight.set(key, publishing)
    return publishing
  }

  const report = (error: unknown) => {
    if (!signal.aborted) options.onError(error)
  }

  const retry = async () => {
    if (signal.aborted || scanning) return
    scanning = true
    try {
      const keys = await storage.list(prefix)
      if (signal.aborted) return
      for (const key of keys) {
        if (key.startsWith(prefix) && !inFlight.has(key)) {
          // A stalled relay ACK for one envelope must not hold up another.
          void attempt(key).catch(report)
        }
      }
    } catch (error) {
      report(error)
    } finally {
      scanning = false
    }
  }

  return {
    enqueue,
    async publish(event: VerifiedEvent, innerEventId?: string): Promise<VerifiedEvent> {
      await enqueue(event, innerEventId)
      return (await attempt(prefix + event.id)) ?? event
    },
    start() {
      if (started || signal.aborted) return
      started = true
      onlineTarget?.addEventListener('online', retry)
      timer = setInterval(retry, Math.max(1000, options.retryIntervalMs ?? 30_000))
      void retry()
    },
    close() {
      controller.abort()
      clearInterval(timer)
      onlineTarget?.removeEventListener('online', retry)
      enqueuing.clear()
      inFlight.clear()
    },
  }
}

export type RuntimePublishResult = {
  size: number
  [Symbol.iterator]?: () => IterableIterator<unknown>
}

function relayUrlFromPublishedRelay(relay: unknown): string | null {
  if (!relay || typeof relay !== 'object') return null

  const directUrl = (relay as { url?: unknown }).url
  if (typeof directUrl === 'string' && directUrl.trim()) {
    return directUrl.trim()
  }

  const nestedUrl = (relay as { relay?: { url?: unknown } }).relay?.url
  if (typeof nestedUrl === 'string' && nestedUrl.trim()) {
    return nestedUrl.trim()
  }

  return null
}

export function getPublishedRelayUrls(publishedRelays: RuntimePublishResult): string[] {
  const iterator = publishedRelays[Symbol.iterator]?.()
  if (!iterator) return []

  const urls: string[] = []
  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    const url = relayUrlFromPublishedRelay(next.value)
    if (url) urls.push(url)
  }
  return Array.from(new Set(urls)).sort()
}

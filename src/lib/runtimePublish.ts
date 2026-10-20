import { assertPrivatePublicationPolicy, coversLegacyPrivateRoster } from './privatePublishPolicy'
import type { NostrPublishContext, StorageAdapter } from 'nostr-double-ratchet'
import { DexieStorageAdapter } from './sessionManagerStorage'
import type { VerifiedEvent } from 'nostr-tools'

/** Private group deliveries require both group and recipient policy checks. */
export type RuntimePublishContext = NostrPublishContext | { groupId: string; recipientOwnerPubkey: string; createdAt: number }

interface PendingPublication {
  event: VerifiedEvent
  innerEventId?: string
  context?: RuntimePublishContext
}

interface RuntimePublishOptions {
  /** Public identity key whose outgoing envelopes this queue may publish. */
  owner: string
  publish: (event: VerifiedEvent, signal: AbortSignal, context?: RuntimePublishContext) => Promise<RuntimePublishResult>
  onAcceptedEvent?: (event: VerifiedEvent) => void | Promise<void>
  onAcceptedRelays?: (
    innerEventId: string | undefined,
    relayUrls: string[]
  ) => void | Promise<void>
  canPublish?: (context: RuntimePublishContext) => boolean | 'hold' | Promise<boolean | 'hold'>
  resolveContext?: (innerEventId: string) => Promise<RuntimePublishContext | undefined>
  onError: (error: unknown) => void
  storage?: StorageAdapter
  onlineTarget?: EventTarget
  /** Wake durable retries when a configured relay becomes connected. */
  subscribeConnected?: (onChange: (relayUrls: readonly string[]) => void) => () => void
  retryIntervalMs?: number
}

export const createRuntimePublish = (options: RuntimePublishOptions) => {
  const storage = options.storage ?? new DexieStorageAdapter()
  const prefix = `v1/runtime-outbox/${options.owner}/`
  const controller = new AbortController()
  const { signal } = controller
  const enqueuing = new Map<string, Promise<void>>()
  const policyAttempts = new Map<AbortController, RuntimePublishContext>()
  const inFlight = new Map<string, Promise<VerifiedEvent | undefined>>()
  const onlineTarget =
    options.onlineTarget ?? (typeof window !== 'undefined' ? window : undefined)
  let timer: ReturnType<typeof setInterval> | undefined
  let unsubscribeConnected: (() => void) | undefined
  let connectionRevision = 0
  let started = false
  let scanning = false

  const enqueue = async (
    event: VerifiedEvent,
    innerEventId?: string,
    context?: RuntimePublishContext,
  ): Promise<void> => {
    signal.throwIfAborted()
    if (!event.id || !event.sig) throw new Error('Cannot queue an unsigned event')
    assertPrivatePublicationPolicy(event)
    const key = prefix + event.id
    const pending = enqueuing.get(key)
    if (pending) return pending

    // Keep the signed envelope unchanged even if its caller later mutates it.
    const row: PendingPublication = { event: structuredClone(event), innerEventId, ...(context && { context: { ...context } }) }
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

    const startedRevision = connectionRevision
    const publishing = (async () => {
      await enqueuing.get(key)
      signal.throwIfAborted()
      const row = await storage.get<PendingPublication>(key)
      signal.throwIfAborted()
      if (!row) return
      assertPrivatePublicationPolicy(row.event)
      if (!row.context && row.innerEventId && options.resolveContext) {
        row.context = await options.resolveContext(row.innerEventId)
        signal.throwIfAborted()
        if (row.context) await storage.put(key, row)
      }
      if (row.context && options.canPublish) {
        const decision = await options.canPublish(row.context)
        signal.throwIfAborted()
        if (decision === false) { await storage.del(key); return }
        if (decision === 'hold') return
      }
      signal.throwIfAborted()
      const groupController = row.context ? new AbortController() : undefined
      if (groupController) policyAttempts.set(groupController, row.context!)
      const attemptSignal = groupController ? AbortSignal.any([signal, groupController.signal]) : signal
      let accepted: RuntimePublishResult
      try {
        accepted = await options.publish(row.event, attemptSignal, row.context)
        attemptSignal.throwIfAborted()
      } finally {
        if (groupController) policyAttempts.delete(groupController)
      }
      if (accepted.size === 0)
        throw new Error('Runtime event was not accepted by any relay')
      signal.throwIfAborted()
      await options.onAcceptedRelays?.(
        row.innerEventId,
        getPublishedRelayUrls(accepted)
      )
      await options.onAcceptedEvent?.(row.event)
      // Keep retries until the ACK and host callback succeed for the active account.
      signal.throwIfAborted()
      await storage.del(key)
      if (row.event.kind === 37368) {
        for (const blockedKey of await storage.list(prefix)) {
          const blocked = await storage.get<PendingPublication>(blockedKey)
          signal.throwIfAborted()
          if (blocked && coversLegacyPrivateRoster(row.event, blocked.event)) await storage.del(blockedKey)
        }
      }
      return row.event
    })().finally(() => {
      inFlight.delete(key)
      // A connection may arrive while the prior offline attempt is settling.
      if (connectionRevision !== startedRevision && !signal.aborted) void retry()
    })
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
    async publish(event: VerifiedEvent, innerEventId?: string, context?: RuntimePublishContext): Promise<VerifiedEvent> {
      await enqueue(event, innerEventId, context)
      return (await attempt(prefix + event.id)) ?? event
    },
    cancelGroup(groupId: string) {
      for (const [attempt, context] of policyAttempts) if (context.groupId === groupId) attempt.abort()
    },
    cancelDirect(recipientOwnerPubkey: string) {
      for (const [attempt, context] of policyAttempts) if (context.recipientOwnerPubkey === recipientOwnerPubkey) attempt.abort()
    },
    start() {
      if (started || signal.aborted) return
      started = true
      onlineTarget?.addEventListener('online', retry)
      let connected = new Set<string>()
      unsubscribeConnected = options.subscribeConnected?.(urls => {
        const next = new Set(urls)
        const newlyConnected = urls.some(url => !connected.has(url))
        connected = next
        if (!newlyConnected || signal.aborted) return
        connectionRevision++
        void retry()
      })
      timer = setInterval(retry, Math.max(1000, options.retryIntervalMs ?? 30_000))
      void retry()
    },
    close() {
      controller.abort()
      clearInterval(timer)
      onlineTarget?.removeEventListener('online', retry)
      unsubscribeConnected?.()
      unsubscribeConnected = undefined
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

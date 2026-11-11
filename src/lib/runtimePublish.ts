import { assertPrivatePublicationPolicy, coversLegacyPrivateRoster } from './privatePublishPolicy'
import { isSharedGroupCiphertext, type NostrPublishContext, type StorageAdapter } from 'nostr-double-ratchet'
import { namesNoRecipient, type PublicationCarrier } from './workerPublicationPolicy'
import { DexieStorageAdapter } from './sessionManagerStorage'
import type { VerifiedEvent } from 'nostr-tools'

interface PendingPublication {
  event: VerifiedEvent
  innerEventId?: string
  context?: NostrPublishContext
}

// A pairwise ratchet carrier and shared group ciphertext look the same on the
// wire. This queue receives envelopes straight from the private sessions, in the
// context that knows which is which, and records that it accepted each one. The
// record outlives the queue row: retries after a reload and local replay to this
// account's own devices both ask for it, and anything without one stays local.
const VOUCHER_LIMIT = 8192
const voucherPrefix = (owner: string) => `v1/pairwise-carrier/${owner}/`

/** Message envelope ids this account's private sessions produced. */
export async function pairwiseCarrierIds(storage: StorageAdapter, owner: string, ids: readonly string[]): Promise<Set<string>> {
  const prefix = voucherPrefix(owner)
  const known = await Promise.all(ids.map(async id => await storage.get(prefix + id) !== undefined))
  return new Set(ids.filter((_, index) => known[index]))
}

interface RuntimePublishOptions {
  /** Public identity key whose outgoing envelopes this queue may publish. */
  owner: string
  publish: (event: VerifiedEvent, signal: AbortSignal, context?: NostrPublishContext,
    carrier?: PublicationCarrier) => Promise<RuntimePublishResult>
  onAcceptedEvent?: (event: VerifiedEvent) => void | Promise<void>
  onAcceptedRelays?: (
    innerEventId: string | undefined,
    relayUrls: string[]
  ) => void | Promise<void>
  canPublish?: (context: NostrPublishContext) => boolean | 'hold' | Promise<boolean | 'hold'>
  resolveContext?: (innerEventId: string) => Promise<NostrPublishContext | undefined>
  onError: (error: unknown) => void
  storage?: StorageAdapter
  onlineTarget?: EventTarget
  /** Wake durable retries when a configured relay becomes connected. */
  subscribeConnected?: (onChange: (relayUrls: readonly string[]) => void) => () => void
  retryIntervalMs?: number
  /** Accepted-envelope records kept for replay to own devices; queued ones are always kept. */
  carrierRecordLimit?: number
}

export const createRuntimePublish = (options: RuntimePublishOptions) => {
  const storage = options.storage ?? new DexieStorageAdapter()
  const prefix = `v1/runtime-outbox/${options.owner}/`
  const vouchers = voucherPrefix(options.owner)
  const voucherLimit = Math.max(4, options.carrierRecordLimit ?? VOUCHER_LIMIT)
  let vouchedSincePrune = 0
  const controller = new AbortController()
  const { signal } = controller
  const enqueuing = new Map<string, Promise<void>>()
  const policyAttempts = new Map<AbortController, NostrPublishContext>()
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
    context?: NostrPublishContext,
  ): Promise<void> => {
    signal.throwIfAborted()
    if (!event.id || !event.sig) throw new Error('Cannot queue an unsigned event')
    assertPrivatePublicationPolicy(event)
    if (event.kind === 1060) {
      // Device keys are public: a recipient tag lets anyone link deliveries to devices.
      if (event.tags.some(tag => tag[0] === 'p')) throw new Error('Message envelopes must not name a recipient')
      if (!namesNoRecipient(event)) throw new Error('Message envelopes carry only the version and header')
      if (isSharedGroupCiphertext(event.id)) throw new Error('Group messages must use private sessions')
    }
    const key = prefix + event.id
    const pending = enqueuing.get(key)
    if (pending) return pending

    // Keep the signed envelope unchanged even if its caller later mutates it.
    const row: PendingPublication = { event: structuredClone(event), innerEventId, ...(context && { context: { ...context } }) }
    const writing = (async () => {
      if (event.kind === 1060) {
        await storage.put(vouchers + event.id, Date.now())
        signal.throwIfAborted()
        if (++vouchedSincePrune >= 512) void pruneVouchers().catch(report)
      }
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
      let carrier: PublicationCarrier | undefined
      if (row.event.kind === 1060) {
        // Envelopes queued by an older version name their recipient, and nothing
        // vouches for a row this queue did not accept itself: both stay local.
        if (!namesNoRecipient(row.event) || await storage.get(vouchers + row.event.id) === undefined) return
        signal.throwIfAborted()
        carrier = 'pairwise'
      }
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
        accepted = await options.publish(row.event, attemptSignal, row.context, carrier)
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

  // Replay only needs recent envelopes; a queued one never loses its record.
  const pruneVouchers = async () => {
    vouchedSincePrune = 0
    const keys = await storage.list(vouchers)
    if (signal.aborted || keys.length <= voucherLimit) return
    const queued = new Set((await storage.list(prefix)).map(key => key.slice(prefix.length)))
    const aged = (await Promise.all(keys.filter(key => !queued.has(key.slice(vouchers.length)))
      .map(async key => ({ key, at: await storage.get<number>(key) ?? 0 })))).sort((a, b) => a.at - b.at)
    for (const { key } of aged.slice(0, keys.length - Math.floor(voucherLimit * 3 / 4))) {
      if (signal.aborted) return
      await storage.del(key)
    }
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
    async publish(event: VerifiedEvent, innerEventId?: string, context?: NostrPublishContext): Promise<VerifiedEvent> {
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
      void pruneVouchers().catch(report)
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

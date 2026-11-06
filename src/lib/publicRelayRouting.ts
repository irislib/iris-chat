import type { NostrRuntime, NostrFilter } from 'nostr-pubsub'

// Other kinds include message envelopes, signer traffic, device announcements,
// invites and authorization. Their established relay policy stays unchanged.
export const isPublicRelayKind = (kind: number): boolean => [0, 1, 3, 10000, 10002].includes(kind)
const publicFilters = (filters: NostrFilter[]): boolean => filters.length > 0 && filters.every(filter =>
  !!filter.kinds?.length && filter.kinds.every(isPublicRelayKind))

/** Explicit public routes must follow settings changes just like default routes. */
export function publicRelaySubscriptions(subscribe: NostrRuntime['subscribe'],
  getRelays: () => readonly string[], getSources: () => string[]) {
  const active = new Set<() => void>()
  const closes = new Set<() => void>()
  const routed: NostrRuntime['subscribe'] = (filters, handlers, options = {}) => {
    if (options.relays !== undefined || options.cache === 'cache-only' || !publicFilters(filters)) {
      return subscribe(filters, handlers, options)
    }
    let current: ReturnType<NostrRuntime['subscribe']> | undefined, closed = false, generation = 0
    const seen = new Set<string>()
    const reopen = () => {
      const run = ++generation
      current?.close()
      current = subscribe(filters, {
        onEvent: (event, info) => {
          if (closed || run !== generation || seen.has(event.id)) return
          seen.add(event.id)
          if (seen.size > 8192) seen.delete(seen.values().next().value!)
          handlers.onEvent(event, info)
        },
        onEose: status => { if (!closed && run === generation) handlers.onEose?.(status) },
        onError: error => { if (!closed && run === generation) handlers.onError?.(error) },
      }, { ...options, relays: getRelays(), sources: options.sources ?? getSources() })
    }
    const close = () => {
      closed = true; generation++
      current?.close(); active.delete(reopen); closes.delete(close)
      options.signal?.removeEventListener('abort', close)
    }
    if (!options.signal?.aborted) {
      active.add(reopen); closes.add(close)
      options.signal?.addEventListener('abort', close, { once: true })
      try { reopen() } catch (error) { close(); throw error }
    }
    return { close }
  }
  return { subscribe: routed, update: () => { for (const reopen of active) reopen() },
    close: () => { for (const close of closes) close() } }
}

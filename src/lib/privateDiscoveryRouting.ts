import { splitRelayDiscoveryFilters, type NostrFilter, type NostrRuntime, type RuntimeCompletion } from 'nostr-pubsub/private-relays'

type Subscribe = NostrRuntime['subscribe']
// One lookup filter stays well inside a relay frame and the runtime's batch bounds.
const MAX_LOOKUP_KEYS = 256
const MAX_ROUTE_FILTERS = 20
const MAX_ROUTE_BYTES = 24_000

/**
 * Separate public lookups (profiles, relay lists, devices, invites) from private
 * receiving interests. Protocol admission stays shared across clients; lookup keys
 * are batched again so one author batch is one request, not one per author.
 */
export function splitPrivateDiscoveryFilters(filters: NostrFilter[]): { receiver: NostrFilter[]; discovery: NostrFilter[] } {
  const split = splitRelayDiscoveryFilters(filters)
  const batches = new Map<string, { filter: NostrFilter; selector: 'authors' | '#p'; keys: string[] }>()
  for (const scoped of split.discovery.flat()) {
    const selector = scoped.authors !== undefined ? 'authors' : '#p'
    const { [selector]: keys, ...rest } = scoped
    const id = `${selector}:${JSON.stringify(rest)}`
    const batch = batches.get(id)
    if (batch) batch.keys.push(...keys as string[])
    else batches.set(id, { filter: rest, selector, keys: [...keys as string[]] })
  }
  const discovery: NostrFilter[] = []
  for (const { filter, selector, keys } of batches.values()) {
    for (let start = 0; start < keys.length; start += MAX_LOOKUP_KEYS) {
      discovery.push({ ...filter, [selector]: keys.slice(start, start + MAX_LOOKUP_KEYS) })
    }
  }
  return { receiver: split.receiver, discovery }
}

function lookupRoutes(filters: NostrFilter[]): NostrFilter[][] {
  const routes: NostrFilter[][] = []
  let current: NostrFilter[] = [], bytes = 0
  for (const filter of filters) {
    const size = JSON.stringify(filter).length
    if (current.length && (current.length >= MAX_ROUTE_FILTERS || bytes + size > MAX_ROUTE_BYTES)) {
      routes.push(current); current = []; bytes = 0
    }
    current.push(filter); bytes += size
  }
  if (current.length) routes.push(current)
  return routes
}

function completion(statuses: RuntimeCompletion[]): RuntimeCompletion {
  const sources = new Map<string, RuntimeCompletion['sources']>()
  for (const status of statuses) for (const source of status.sources) {
    const previous = sources.get(source.id)
    if (previous) previous.push(source)
    else sources.set(source.id, [source])
  }
  const incomplete = statuses.find(status => !status.complete)
  return {
    complete: !incomplete,
    reason: incomplete?.reason ?? (statuses.every(status => status.reason === 'cache') ? 'cache' : 'eose'),
    sources: [...sources].map(([id, reports]) => ({
      id,
      complete: reports.every(report => report.complete),
      ...(reports.some(report => report.error) ? {
        error: [...new Set(reports.flatMap(report => report.error ? [report.error] : []))].join('; '),
      } : {}),
    })),
  }
}

/**
 * Public lookups use the account runtime's own relay connections and never a
 * peer source: a device stream must not learn which people this account looks up.
 */
export function privateDiscoverySubscribe(subscribe: Subscribe): Subscribe {
  return (filters, handlers, options = {}) => {
    const split = splitPrivateDiscoveryFilters(filters)
    const routes = [
      ...(split.receiver.length ? [{ filters: split.receiver, options }] : []),
      ...lookupRoutes(split.discovery).map(filters => ({ filters, options: { ...options, sources: [] } })),
    ]
    if (!routes.length) return subscribe(filters, handlers, options)
    if (routes.length === 1) return subscribe(routes[0].filters, handlers, routes[0].options)
    const statuses = new Map<number, RuntimeCompletion>()
    const seen = new Set<string>()
    const opened: Array<ReturnType<Subscribe>> = []
    let closed = false
    try {
      for (const [index, route] of routes.entries()) opened.push(subscribe(route.filters, {
        onEvent: (event, info) => {
          if (closed || seen.has(event.id)) return
          seen.add(event.id)
          if (seen.size > 8192) seen.delete(seen.values().next().value!)
          handlers.onEvent(event, info)
        },
        onEose: status => {
          if (closed) return
          statuses.set(index, status)
          if (statuses.size === routes.length) handlers.onEose?.(completion([...statuses.values()]))
        },
        onError: error => { if (!closed) handlers.onError?.(error) },
      }, route.options))
    } catch (error) {
      closed = true
      for (const subscription of opened) subscription.close()
      throw error
    }
    return { close: () => {
      closed = true
      for (const subscription of opened) subscription.close()
    } }
  }
}

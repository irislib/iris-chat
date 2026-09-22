import { readable } from 'svelte/store'
import { AppKeys, buildAppKeysFilter, type NostrSubscribe } from 'nostr-double-ratchet'

export type MessagingSupportEvent = Parameters<Parameters<NostrSubscribe>[1]>[0]
export type PeopleSubscribe = (
  filter: Parameters<NostrSubscribe>[0],
  onEvent: Parameters<NostrSubscribe>[1],
  onEose?: () => void,
) => () => void
export interface MessagingPeopleState {
  events: Map<string, MessagingSupportEvent>
  loading: boolean
}
export const MAX_MESSAGING_PEOPLE = 512

export function messagingDeviceList(event: MessagingSupportEvent, owner: string): string[] | undefined {
  if (!event || !Number.isSafeInteger(event.created_at) || event.pubkey !== owner || event.created_at > Math.floor(Date.now() / 1000) + 300) return
  try {
    return AppKeys.fromEvent(event).getAllDevices().map(device => device.identityPubkey).sort()
  } catch {
    return
  }
}

export function createMessagingPeopleStore(
  owners: string[],
  options: {
    subscribe: PeopleSubscribe
    initialEvents?: MessagingSupportEvent[]
    onCache?: (events: MessagingSupportEvent[], critical: boolean) => void
  },
) {
  const normalize = (keys: string[]) => new Set(keys.filter(owner => /^[0-9a-f]{64}$/.test(owner)).slice(0, MAX_MESSAGING_PEOPLE))
  let requested = normalize(owners)
  let update: (() => void) | undefined
  const store = readable<MessagingPeopleState>({ events: new Map(), loading: requested.size > 0 }, set => {
    let active = true
    let loading = requested.size > 0
    // Keep both conflicting heads in the cache: a restart must not turn an
    // ambiguous same-time device list into an apparently verified result.
    const heads = new Map<string, { time: number; variants: Map<string, MessagingSupportEvent> }>()
    const publish = () => {
      const events = new Map<string, MessagingSupportEvent>()
      for (const [owner, head] of heads) {
        if (!requested.has(owner) || head.variants.size !== 1) continue
        const [roster, event] = [...head.variants][0]
        if (roster !== '[]') events.set(owner, event)
      }
      set({ events, loading })
    }
    const receive = (event: MessagingSupportEvent, persist: boolean) => {
      if (!active || !requested.has(event?.pubkey)) return
      const devices = messagingDeviceList(event, event.pubkey)
      if (!devices) return
      const previous = heads.get(event.pubkey)
      if (previous && previous.time > event.created_at) return
      const head = previous?.time === event.created_at ? previous : { time: event.created_at, variants: new Map<string, MessagingSupportEvent>() }
      const roster = JSON.stringify([...new Set(devices)])
      if (head.variants.get(roster)?.id === event.id) return
      if (head.variants.has(roster) || head.variants.size < 2) head.variants.set(roster, event)
      heads.set(event.pubkey, head)
      if (persist) options.onCache?.([...head.variants.values()], devices.length === 0 || head.variants.size > 1)
      publish()
    }
    type Batch = { owners: string[]; done: boolean; stop: () => void; timer?: ReturnType<typeof setTimeout> }
    const batches = new Set<Batch>()
    const updateLoading = () => {
      loading = [...batches].some(batch => !batch.done && batch.owners.some(owner => requested.has(owner)))
      publish()
    }
    update = () => {
      for (const batch of batches) {
        // Narrow changed batches too: a removed owner must get a fresh replay
        // when re-added, including any revocation received while absent.
        if (batch.owners.every(owner => requested.has(owner))) continue
        clearTimeout(batch.timer)
        batch.stop()
        batches.delete(batch)
      }
      // Restore cached heads when owners first enter the search, then retain
      // them while the query changes so a stale result cannot undo a revocation.
      for (const event of options.initialEvents ?? []) receive(event, false)
      for (const owner of heads.keys()) {
        if (heads.size <= MAX_MESSAGING_PEOPLE * 2) break
        if (!requested.has(owner)) heads.delete(owner)
      }
      const subscribed = new Set([...batches].flatMap(batch => batch.owners))
      const keys = [...requested].filter(owner => !subscribed.has(owner))
      for (let i = 0; i < keys.length; i += 64) {
        const batch: Batch = { owners: keys.slice(i, i + 64), done: false, stop: () => {} }
        batches.add(batch)
        const complete = () => {
          if (!active || batch.done || !batches.has(batch)) return
          batch.done = true
          clearTimeout(batch.timer)
          updateLoading()
        }
        batch.timer = setTimeout(complete, 5000)
        batch.stop = options.subscribe({ ...buildAppKeysFilter(batch.owners), limit: 2048 }, event => receive(event, true), complete)
      }
      updateLoading()
    }
    update()
    return () => {
      active = false
      update = undefined
      for (const batch of batches) { clearTimeout(batch.timer); batch.stop() }
    }
  })
  return {
    subscribe: store.subscribe,
    setOwners(owners: string[]) {
      const next = normalize(owners)
      if (next.size === requested.size && [...next].every(owner => requested.has(owner))) return
      requested = next
      update?.()
    },
  }
}

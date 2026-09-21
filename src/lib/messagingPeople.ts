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
  const requested = new Set(owners.filter(owner => /^[0-9a-f]{64}$/.test(owner)).slice(0, MAX_MESSAGING_PEOPLE))
  return readable<MessagingPeopleState>({ events: new Map(), loading: requested.size > 0 }, set => {
    let active = true
    let loading = requested.size > 0
    // Keep both conflicting heads in the cache: a restart must not turn an
    // ambiguous same-time device list into an apparently verified result.
    const heads = new Map<string, { time: number; variants: Map<string, MessagingSupportEvent> }>()
    const publish = () => {
      const events = new Map<string, MessagingSupportEvent>()
      for (const [owner, head] of heads) {
        if (head.variants.size !== 1) continue
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
    for (const event of options.initialEvents ?? []) receive(event, false)
    publish()
    const stops: Array<() => void> = []
    const keys = [...requested]
    let pending = Math.ceil(keys.length / 64)
    for (let i = 0; i < keys.length; i += 64) {
      let complete = false
      stops.push(options.subscribe({ ...buildAppKeysFilter(keys.slice(i, i + 64)), limit: 2048 }, event => receive(event, true), () => {
        if (!active || complete) return
        complete = true
        if (--pending === 0) { loading = false; publish() }
      }))
    }
    const timeout = setTimeout(() => { if (active) { loading = false; publish() } }, 5000)
    return () => { active = false; clearTimeout(timeout); for (const stop of stops) stop() }
  })
}

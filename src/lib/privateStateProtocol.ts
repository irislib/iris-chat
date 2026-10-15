import { parsePrivateEvent, type PrivateEvent } from 'nostr-social-graph/privateEvents'
export const PRIVATE_BLOCK_KIND = 10454
export const PRIVATE_NAME_APPROVAL_KIND = 10455
export interface NameChange { previous_name: string; accepted_name: string; accepted_at_secs: number }
export interface NameApproval { v: 1; owner: string; contact: string; revision: number; firstSeenName: string; change: NameChange }
export interface BlockState { v: 1; owner: string; target: string; blocked: boolean; revision: number; blockedSince: number | null; deletedAt: number }
export interface MessageReadState { createdAtSecs: number; expiresAtSecs?: number }
export const privateKey = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const time = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const name = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && new TextEncoder().encode(value).length <= 320
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key))
export function privateEventState(event: PrivateEvent): NameApproval | BlockState | undefined {
  if (!object(event) || ![10454, 10455].includes(event.kind) || !privateKey(event.id) || !privateKey(event.pubkey) ||
    !time(event.created_at) || event.created_at > Date.now() / 1000 + 300 || typeof event.content !== 'string' ||
    new TextEncoder().encode(event.content).length > (event.kind === 10454 ? 2048 : 4096) ||
    !Array.isArray(event.tags) || event.tags.length !== 2 || !event.tags.every(tag => Array.isArray(tag) && tag.every(v => typeof v === 'string'))) return
  try {
    parsePrivateEvent(event, true)
    const state = JSON.parse(event.content)
    if (!object(state) || state.v !== 1 || !privateKey(state.owner) || !time(state.revision)) return
    const target = event.kind === 10454 ? state.target : state.contact
    if (!privateKey(target) || target === state.owner || !event.tags.some(tag => JSON.stringify(tag) === JSON.stringify(['p', state.owner])) ||
      !event.tags.some(tag => JSON.stringify(tag) === JSON.stringify(['d', `iris:${event.kind === 10454 ? 'block' : 'name-approval'}:${target}`]))) return
    if (event.kind === 10454) {
      if (!exact(state, ['v','owner','target','blocked','revision','blockedSince','deletedAt']) || typeof state.blocked !== 'boolean' || !time(state.deletedAt) || state.deletedAt > event.created_at + 300 ||
        (state.blockedSince != null && (!time(state.blockedSince) || state.blockedSince === 0 || state.blockedSince > event.created_at)) || state.blocked && state.blockedSince == null) return
      return { ...state, blockedSince: state.blockedSince ?? null } as BlockState
    }
    const change = state.change
    if (!exact(state, ['v','owner','contact','revision','firstSeenName','change']) || !name(state.firstSeenName) || !object(change) ||
      !name(change.previous_name) || !name(change.accepted_name) || change.previous_name === change.accepted_name || !time(change.accepted_at_secs) || change.accepted_at_secs > event.created_at) return
    return state as unknown as NameApproval
  } catch { return }
}
/** Same order as native. Concurrent blocks win; approvals retain every transition. */
export function comparePrivateEvents(a: PrivateEvent, b: PrivateEvent): number {
  const x = privateEventState(a)!, y = privateEventState(b)!
  return x.revision - y.revision || (a.kind === 10454 ? Number((x as BlockState).blocked) - Number((y as BlockState).blocked) :
    (x as NameApproval).change.accepted_at_secs - (y as NameApproval).change.accepted_at_secs) ||
    (a.pubkey < b.pubkey ? -1 : Number(a.pubkey > b.pubkey)) || (a.id < b.id ? -1 : Number(a.id > b.id))
}
export function blockedIntervals(events: PrivateEvent[]): Array<[number, number | null]> {
  const sorted = events.filter(event => event.kind === 10454 && privateEventState(event)).sort(comparePrivateEvents)
  return sorted.flatMap((event, index) => {
    const state = privateEventState(event) as BlockState
    if (state.blockedSince === null) return []
    const until = state.blocked ? sorted.slice(index + 1).find(next => !(privateEventState(next) as BlockState).blocked)?.created_at : event.created_at
    return [[state.blockedSince, until === undefined ? null : Math.max(until, state.blockedSince + 1)] as [number, number | null]]
  })
}
export function validMessageRead(value: unknown): value is MessageReadState {
  return object(value) && time(value.createdAtSecs) && value.createdAtSecs <= Date.now() / 1000 + 300 &&
    (value.expiresAtSecs === undefined || time(value.expiresAtSecs))
}

export function privateStateControlEvent(value: unknown, kind: number, owner: string): PrivateEvent | undefined {
  if (!object(value) || value.v !== 1 || value.event?.kind !== kind || value.type !== (kind === 10454 ? 'private-block-state' : 'private-name-approval') || privateEventState(value.event)?.owner !== owner) return
  return parsePrivateEvent(value.event, true)
}

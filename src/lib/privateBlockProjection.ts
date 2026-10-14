import { get, writable } from 'svelte/store'
/** Account-scoped cache for synchronous call/message admission; signed records remain authoritative. */
export const privateBlockedContacts = writable(new Map<string, Set<string>>())
export function blockedContacts(owner: string | null): Set<string> { return owner ? get(privateBlockedContacts).get(owner) ?? new Set() : new Set() }
export function replaceBlockedContacts(owner: string, next: Set<string>): void {
  const previous = blockedContacts(owner)
  if (previous.size === next.size && [...next].every(key => previous.has(key))) return
  privateBlockedContacts.update(all => new Map(all).set(owner, next))
}

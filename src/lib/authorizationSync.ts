import { AppKeys, isAppKeysEvent, isGroupRosterFactEvent, parseGroupRosterFactEvent } from 'nostr-double-ratchet'
import type { Event, VerifiedEvent } from 'nostr-tools'
import { db } from './storage'
import { deviceRecordVersion } from './deviceSyncRecordStore'

const prefix = (owner: string) => `authorization-event-v1:${owner}:`
/** Signed authorization proofs; group membership proofs are kept private. */
export function authorizationEvent(value: unknown): VerifiedEvent | undefined {
  try {
    const event = structuredClone(value) as VerifiedEvent
    if (!event || new TextEncoder().encode(JSON.stringify(event)).length > 64 * 1024 || event.created_at > Date.now() / 1000 + 300) return
    if (isAppKeysEvent(event)) AppKeys.fromEvent(event)
    else if (isGroupRosterFactEvent(event)) parseGroupRosterFactEvent(event)
    else return
    return structuredClone(event)
  } catch { return }
}
export async function saveAuthorizationEvent(owner: string, value: unknown, authorized = () => true): Promise<boolean> {
  const event = authorizationEvent(value)
  if (!event || !authorized()) return false
  const inserted = await db.transaction('rw', db.sessionManager, async () => {
    if (!authorized()) throw new Error('Account changed')
    const key = prefix(owner) + event.id
    if (await db.sessionManager.get(key)) return false
    await db.sessionManager.put({ key, value: event })
    return true
  })
  if (inserted) deviceRecordVersion.update(n => n + 1)
  return true
}
export async function* authorizationEvents(owner: string): AsyncGenerator<VerifiedEvent> {
  const base = prefix(owner)
  let after: string | undefined
  while (true) {
    const rows = await db.sessionManager.where('key').between(after ?? base, `${base}\uffff`, after === undefined, true).limit(256).toArray()
    for (const row of rows) { const event = authorizationEvent(row.value); if (event) yield event }
    if (rows.length < 256) return
    after = rows.at(-1)!.key
  }
}
export async function authorizationById(owner: string, id: string): Promise<VerifiedEvent | undefined> {
  return authorizationEvent((await db.sessionManager.get(prefix(owner) + id))?.value)
}
export async function restoreAuthorizationProjections(owner: string, authorized: () => boolean): Promise<void> {
  const rosters = new Map<string, VerifiedEvent>()
  for await (const event of authorizationEvents(owner)) {
    if (!authorized()) throw new Error('Account changed')
    if (isAppKeysEvent(event)) {
      const previous = rosters.get(event.pubkey)
      if (!previous || event.created_at > previous.created_at || event.created_at === previous.created_at && event.id < previous.id) rosters.set(event.pubkey, event)
    } else await applyAuthorizationEvent(owner, event, authorized)
  }
  // Replaying a historical own roster first could temporarily remove this
  // device and trigger local-data removal before its newer grant is restored.
  for (const event of rosters.values()) await applyAuthorizationEvent(owner, event, authorized)
}
export async function applyAuthorizationEvent(owner: string, value: Event, authorized: () => boolean): Promise<void> {
  const event = authorizationEvent(value)
  if (!event || !authorized()) throw new Error('Invalid authorization record')
  // Persist the projection before advertising the original in our inventory,
  // so an interrupted write remains missing and gets retried by reconciliation.
  if (isAppKeysEvent(event)) {
    const { getNdrRuntime } = await import('./privateChats')
    if (!authorized()) throw new Error('Account changed')
    await getNdrRuntime().applyVerifiedAppKeysEvent(event)
  } else {
    const { applySyncedGroupRosterFact } = await import('./groups')
    if (!authorized()) throw new Error('Account changed')
    await applySyncedGroupRosterFact(event)
  }
  // Retain the signature even when runtime admission finds a newer projection.
  if (!await saveAuthorizationEvent(owner, event, authorized)) throw new Error('Account changed')
}

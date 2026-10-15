import { get } from 'svelte/store'
import { getEventHash } from 'nostr-tools'
import { buildPrivateEvent, parsePrivateEvent, type PrivateEvent } from 'nostr-social-graph/privateEvents'
import type { Rumor, OnEventMeta } from 'nostr-double-ratchet'
import { getPubkey } from './identity'
import { devices } from './devices'
import { db } from './storage'
import { waitForNdrRuntime } from './privateChats'
import { privateStateControlEvent, privateEventState, type NameChange, type BlockState } from './privateStateProtocol'
import { savePrivateStateEvent, contactPrivateEvents, readState } from './privateStateStore'
const authorized = (owner: string) => getPubkey() === owner && get(devices).isCurrentDeviceRegistered
const pendingKey = (owner: string, id: string) => `private-state-pending:${owner}:${id}`
async function sendPrivateEvent(owner: string, event: PrivateEvent): Promise<void> {
  event = parsePrivateEvent(event, true)
  if (!authorized(owner)) return
  const runtime = await waitForNdrRuntime()
  if (!authorized(owner)) return
  const draft = { pubkey: owner, kind: event.kind, created_at: Math.floor(Date.now() / 1000), tags: [['p', owner]],
    content: JSON.stringify({ v: 1, type: event.kind === 10454 ? 'private-block-state' : 'private-name-approval', event }) }
  const rumor = { ...draft, id: getEventHash(draft) }
  const accepted = await runtime.sendEvent(owner, rumor)
  if (authorized(owner) && accepted?.id === rumor.id) await db.sessionManager.delete(pendingKey(owner, event.id))
}
export async function retryPrivateStateControls(owner: string): Promise<void> {
  const memoryPrefix = `iris-contact-memory:v1:${owner}:`
  const legacy: Array<{contact: string; first: string; changes: NameChange[]}> = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith(memoryPrefix)) continue
    try { const memory = JSON.parse(localStorage.getItem(key)!); if (typeof memory.first_seen_name === 'string' && Array.isArray(memory.name_changes)) legacy.push({contact: key.slice(memoryPrefix.length), first: memory.first_seen_name, changes: memory.name_changes}) } catch { /* Keep malformed local data intact. */ }
  }
  for (const memory of legacy) {
    const known = new Set((await contactPrivateEvents(owner, memory.contact, 10455)).map(event => JSON.stringify((privateEventState(event) as { change: NameChange }).change)))
    for (const change of memory.changes) if (!known.has(JSON.stringify(change)) && authorized(owner)) await writeNameApproval(owner, memory.contact, memory.first, change, true)
  }
  const prefix = `private-state-pending:${owner}:`
  let after: string | undefined
  while (authorized(owner)) {
    const rows = await db.sessionManager.where('key').between(after ?? prefix, `${prefix}\uffff`, after === undefined, true).limit(64).toArray()
    for (const row of rows) { await savePrivateStateEvent(owner, row.value as PrivateEvent, () => authorized(owner)); await sendPrivateEvent(owner, row.value as PrivateEvent) }
    if (rows.length < 64) return
    after = rows.at(-1)!.key
  }
}
async function writePrivateEvent(owner: string, target: string, kind: 10454 | 10455, content: Record<string, unknown>): Promise<void> {
  if (getPubkey() !== owner) throw new Error('Account changed')
  const runtime = await waitForNdrRuntime()
  const pubkey = runtime.getState().currentDevicePubkey
  if (!pubkey || getPubkey() !== owner || runtime.getState().ownerPubkey !== owner) throw new Error('Device changed')
  const event = buildPrivateEvent({ pubkey, kind, created_at: Math.floor(Date.now() / 1000), content: JSON.stringify(content),
    tags: [['p', owner], ['d', `iris:${kind === 10454 ? 'block' : 'name-approval'}:${target}`]] })
  if (privateEventState(event)?.owner !== owner) throw new Error('Invalid private update')
  await db.transaction('rw', db.sessionManager, async () => {
    if (getPubkey() !== owner) throw new Error('Account changed')
    await db.sessionManager.put({ key: pendingKey(owner, event.id), value: event })
    // Persist the pending event first; replay can complete projection after a crash.
  })
  await savePrivateStateEvent(owner, event, () => getPubkey() === owner)
  void sendPrivateEvent(owner, event).catch(() => {})
}
export async function writeNameApproval(owner: string, contact: string, firstSeenName: string, change: NameChange, legacy = false): Promise<void> {
  if (!navigator.locks) throw new Error('Private sync is unavailable')
  await navigator.locks.request(`private-name:${owner}:${contact}`, async () => {
    const previous = (await contactPrivateEvents(owner, contact, 10455)).at(-1)
    const revision = legacy ? 0 : (previous ? privateEventState(previous)!.revision : 0) + 1
    await writePrivateEvent(owner, contact, 10455, { v: 1, owner, contact, revision, firstSeenName, change })
  })
}
export async function setPrivateBlock(owner: string, target: string, blocked: boolean): Promise<void> {
  if (!navigator.locks) throw new Error('Private sync is unavailable')
  await navigator.locks.request(`private-block:${owner}:${target}`, async () => {
    const previous = (await contactPrivateEvents(owner, target, 10454)).at(-1)
    const state = previous && privateEventState(previous) as BlockState | undefined
    await writePrivateEvent(owner, target, 10454, { v: 1, owner, target, blocked, revision: (state?.revision ?? 0) + 1,
      blockedSince: blocked ? state?.blocked ? state.blockedSince : Math.floor(Date.now() / 1000) : state?.blockedSince ?? null, deletedAt: 0 })
  })
}
export async function receivePrivateStateControl(rumor: Rumor, meta?: OnEventMeta): Promise<void> {
  const owner = getPubkey(), state = get(devices), sender = meta?.senderDevicePubkey || meta?.fromDeviceId
  if (!owner || !authorized(owner) || meta?.senderOwnerPubkey !== owner || !sender || sender === state.identityPubkey ||
    !state.registeredDevices.some(device => device.identityPubkey === sender) || (rumor.pubkey !== owner && rumor.pubkey !== sender) ||
    rumor.tags.some(tag => tag[0] === 'p' && tag[1] !== owner) || rumor.content.length > 8192) return
  let value: { type: string; v: number; event: PrivateEvent }
  try { value = JSON.parse(rumor.content) } catch { return }
  const event = privateStateControlEvent(value, rumor.kind, owner)
  if (!event) return
  await savePrivateStateEvent(owner, event, () => authorized(owner) && get(devices).registeredDevices.some(device => device.identityPubkey === sender))
}
export async function sendOwnReadState(owner: string, chatId: string, ids: string[]): Promise<void> {
  if (!authorized(owner)) return
  const runtime = await waitForNdrRuntime()
  for (let start = 0; start < ids.length; start += 128) {
    const seenMessages: Record<string, Awaited<ReturnType<typeof readState>>> = {}
    for (const id of ids.slice(start, start + 128)) { const read = await readState(owner, chatId, id); if (read) seenMessages[id] = read }
    const selected = Object.keys(seenMessages)
    if (!selected.length || !authorized(owner)) continue
    const tags = [['p', chatId.startsWith('group:') ? owner : chatId], ...selected.map(id => ['e', id]),
      ['iris-read-state', JSON.stringify({ updatedAtMs: Date.now(), deviceId: get(devices).identityPubkey, seenThroughSecs: 0, seenAtBoundary: [], seenMessages })]]
    if (chatId.startsWith('group:')) tags.push(['l', chatId.slice(6)])
    const draft = { pubkey: owner, kind: 15, content: 'seen', tags, created_at: Math.floor(Date.now() / 1000) }
    await runtime.sendEvent(owner, { ...draft, id: getEventHash(draft) })
  }
}
/** Caller admits only an authenticated own-device receipt, never a remote peer receipt. */
export async function applyOwnReadTag(owner: string, chatId: string, rumor: Rumor): Promise<void> {
  await (await import('./ownReadState')).applyAuthenticatedOwnRead(owner,chatId,rumor,() => authorized(owner))
}

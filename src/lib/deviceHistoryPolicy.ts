import { writable } from 'svelte/store'
import { getSessionManagerValue, putSessionManagerValue } from './storage'

export type DeviceHistoryChoice = 'chats' | 'history'
export interface DeviceHistoryPair {
  peer: string
  linkAt: number
  linkId: string
  since: number | null
  role: 'inbound' | 'outbound'
  complete: boolean
  authorized?: boolean
}
export const deviceHistoryProgress = writable<{ phase: 'discovering' | 'transferring' | 'waiting'; imported: number; total?: number } | null>(null)
const writes = new Map<string, Promise<void>>()
const pairs = new Map<string, DeviceHistoryPair[]>()
const key = (owner: string, local: string) => `device-history-pairs:${owner}:${local}`
export function deviceHistoryPair(owner: string, local: string, peer: string): DeviceHistoryPair | undefined {
  return pairs.get(key(owner, local))?.find(pair => pair.peer === peer)
}
export async function loadDeviceHistoryPairs(owner: string, local: string): Promise<void> {
  await writes.get(key(owner, local))
  const stored = await getSessionManagerValue<DeviceHistoryPair[]>(key(owner, local)) ?? []
  pairs.set(key(owner, local), stored)
  deviceHistoryProgress.set(stored.some(pair => pair.role === 'inbound' && !pair.complete && pair.since === 0) ? { phase: 'waiting', imported: 0 } : null)
}
async function updatePairs(owner: string, local: string, change: (existing: DeviceHistoryPair[]) => DeviceHistoryPair[]): Promise<void> {
  const storageKey = key(owner, local)
  const pending = (writes.get(storageKey) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const existing = await getSessionManagerValue<DeviceHistoryPair[]>(storageKey) ?? []
    const next = change(existing)
    await putSessionManagerValue(storageKey, next)
    pairs.set(storageKey, next)
  })
  writes.set(storageKey, pending)
  try { await pending } finally { if (writes.get(storageKey) === pending) writes.delete(storageKey) }
}
export async function saveDeviceHistoryPair(owner: string, local: string, pair: DeviceHistoryPair): Promise<void> {
  await updatePairs(owner, local, existing => {
    const previous = existing.find(item => item.peer === pair.peer)
    if (previous?.linkId === pair.linkId && previous.complete && !pair.complete) return existing
    return [...existing.filter(item => item.peer !== pair.peer), pair]
  })
  if (pair.role === 'inbound') {
    const current = deviceHistoryPair(owner, local, pair.peer)
    deviceHistoryProgress.set(current?.complete || current?.since !== 0 ? null : { phase: 'waiting', imported: 0 })
  }
}

export async function closeRevokedDeviceHistoryPairs(owner: string, local: string, authorized: string[]): Promise<void> {
  const allowed = new Set(authorized)
  const current = pairs.get(key(owner, local)) ?? []
  const revoked = current.filter(pair => pair.authorized && !pair.complete && !allowed.has(pair.peer))
  if (!revoked.length && !current.some(pair => !pair.authorized && allowed.has(pair.peer))) return
  await updatePairs(owner, local, existing => existing.map(pair =>
    revoked.some(previous => previous.peer === pair.peer && previous.linkId === pair.linkId) ? { ...pair, complete: true } :
      allowed.has(pair.peer) ? { ...pair, authorized: true } : pair))
  if (revoked.some(pair => pair.role === 'inbound')) deviceHistoryProgress.set(null)
}

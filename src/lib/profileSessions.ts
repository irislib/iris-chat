import { readable } from 'svelte/store'
import type { SessionUserRecordsLike } from 'nostr-double-ratchet'

export function countProfileSessions(records: SessionUserRecordsLike, pubkey: string) {
  const devices = records.get(pubkey)?.devices
  const active = new Set(
    [...devices?.values() ?? []].map(device => device.activeSession).filter(Boolean)
  )
  const older = new Set(
    [...devices?.values() ?? []]
      .flatMap(device => device.inactiveSessions ?? [])
      .filter(session => session && !active.has(session))
  )
  return { active: active.size, older: older.size, total: active.size + older.size }
}

type SessionManagerSource = { onEventsAvailable: (callback: () => void) => () => void }
type ProfileSessionSource = {
  getSessionUserRecords: () => SessionUserRecordsLike
  getState: () => { sessionManagerReady: boolean }
  getSessionManager: () => SessionManagerSource | null
  onStateChange: (callback: () => void) => () => void
}

export function createProfileSessionsStore(pubkey: string, runtime: ProfileSessionSource) {
  return readable({ active: 0, older: 0, total: 0, loading: true }, set => {
    let active = true
    let manager: SessionManagerSource | null = null
    let stopEvents: (() => void) | undefined
    const refresh = () => {
      if (!active) return
      const currentManager = runtime.getSessionManager()
      if (currentManager !== manager) {
        stopEvents?.()
        manager = currentManager
        // Observe events without draining the protocol's queue. Defer the read
        // until the operation producing the event has finished updating records.
        stopEvents = manager?.onEventsAvailable(() => queueMicrotask(refresh))
      }
      set({
        ...countProfileSessions(runtime.getSessionUserRecords(), pubkey),
        loading: !runtime.getState().sessionManagerReady,
      })
    }
    const stopState = runtime.onStateChange(refresh)
    refresh()
    return () => { active = false; stopState(); stopEvents?.() }
  })
}

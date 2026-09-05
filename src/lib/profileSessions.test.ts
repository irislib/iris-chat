// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { countProfileSessions, createProfileSessionsStore } from './profileSessions'
import type { SessionUserRecordsLike } from 'nostr-double-ratchet'

const session = () => ({}) as never

describe('profile session counts', () => {
  it('counts active and older sessions for only the selected person, not device records', () => {
    const active = session()
    const older = session()
    const records: SessionUserRecordsLike = new Map([
      ['alice', { devices: new Map([
        ['phone', { activeSession: active, inactiveSessions: [older, active] }],
        ['laptop', { inactiveSessions: [] }],
        ['old-phone', { inactiveSessions: [older] }],
      ]) }],
      ['bob', { devices: new Map([['phone', { activeSession: session() }]]) }],
    ])
    expect(countProfileSessions(records, 'alice')).toEqual({ active: 1, older: 1, total: 2 })
    expect(countProfileSessions(records, 'unknown')).toEqual({ active: 0, older: 0, total: 0 })
  })

  it('refreshes after runtime and session changes and removes listeners on close', async () => {
    const records: SessionUserRecordsLike = new Map()
    let stateChange = () => {}
    let eventsAvailable = () => {}
    let ready = false
    const stopState = vi.fn()
    const stopEvents = vi.fn()
    const manager = { onEventsAvailable: (fn: () => void) => { eventsAvailable = fn; return stopEvents } }
    const runtime = {
      getSessionUserRecords: () => records,
      getState: () => ({ sessionManagerReady: ready }),
      getSessionManager: () => ready ? manager : null,
      onStateChange: (fn: () => void) => { stateChange = fn; fn(); return stopState },
    }
    let value: { active: number; older: number; total: number; loading: boolean } | undefined
    const stop = createProfileSessionsStore('alice', runtime).subscribe(next => { value = next })
    expect(value?.loading).toBe(true)
    ready = true
    records.set('alice', { devices: new Map([['phone', { activeSession: session() }]]) })
    stateChange()
    expect(value).toEqual({ active: 1, older: 0, total: 1, loading: false })
    records.get('alice')!.devices!.get('phone')!.inactiveSessions = [session()]
    eventsAvailable()
    await Promise.resolve()
    expect(value?.total).toBe(2)
    stop()
    expect(stopState).toHaveBeenCalledOnce()
    expect(stopEvents).toHaveBeenCalledOnce()
    records.clear()
    eventsAvailable()
    await Promise.resolve()
    expect(value?.total).toBe(2)
  })
})

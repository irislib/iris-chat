import { describe, expect, it } from 'vitest'
import { needsManagerUserSetup } from './chat'
import type { UserRecord } from 'nostr-double-ratchet'

function makeRecord(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    publicKey: 'owner',
    state: 'ready',
    devices: new Map(),
    appKeys: undefined,
    ensureSetup: async () => {},
    onAppKeys: async () => {},
    isDeviceAuthorized: () => false,
    onDeviceRumor: () => {},
    onDeviceDirty: () => {},
    deactivateCurrentSessions: () => {},
    close: () => {},
    ...overrides,
  }
}

describe('needsManagerUserSetup', () => {
  it('returns true when appkeys know more devices than the record has sessions for', () => {
    const record = makeRecord({
      devices: new Map([
        [
          'device-1',
          {
            deviceId: 'device-1',
            state: 'session-ready',
            activeSession: {} as never,
            inactiveSessions: [],
          },
        ],
      ]),
      appKeys: {
        getAllDevices: () => [
          { identityPubkey: 'device-1', createdAt: 100 },
          { identityPubkey: 'device-2', createdAt: 100 },
        ],
      } as never,
    })

    expect(needsManagerUserSetup(record)).toBe(true)
  })

  it('returns true when a known device has no session material yet', () => {
    const record = makeRecord({
      devices: new Map([
        [
          'device-1',
          {
            deviceId: 'device-1',
            state: 'new',
            activeSession: undefined,
            inactiveSessions: [],
          },
        ],
      ]),
      appKeys: {
        getAllDevices: () => [{ identityPubkey: 'device-1', createdAt: 100 }],
      } as never,
    })

    expect(needsManagerUserSetup(record)).toBe(true)
  })

  it('returns false when every known device already has session state', () => {
    const record = makeRecord({
      devices: new Map([
        [
          'device-1',
          {
            deviceId: 'device-1',
            state: 'session-ready',
            activeSession: {} as never,
            inactiveSessions: [],
          },
        ],
        [
          'device-2',
          {
            deviceId: 'device-2',
            state: 'waiting-for-invite',
            activeSession: undefined,
            inactiveSessions: [{} as never],
          },
        ],
      ]),
      appKeys: {
        getAllDevices: () => [
          { identityPubkey: 'device-1', createdAt: 100 },
          { identityPubkey: 'device-2', createdAt: 100 },
        ],
      } as never,
    })

    expect(needsManagerUserSetup(record)).toBe(false)
  })
})

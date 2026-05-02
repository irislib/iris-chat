import { describe, expect, it } from 'vitest'
import { needsManagerUserSetup } from './chat'
import type { DeviceRecord, UserRecord } from 'nostr-double-ratchet'

function makeRecord(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    publicKey: 'owner',
    devices: new Map(),
    appKeys: undefined,
    ...overrides,
  }
}

function makeDeviceRecord(
  deviceId: string,
  overrides: Partial<DeviceRecord> = {}
): DeviceRecord {
  return {
    deviceId,
    activeSession: undefined,
    inactiveSessions: [],
    createdAt: 0,
    prepareOutboundEvent: () => undefined,
    ...overrides,
  }
}

describe('needsManagerUserSetup', () => {
  it('returns true when appkeys know more devices than the record has sessions for', () => {
    const record = makeRecord({
      devices: new Map([
        [
          'device-1',
          makeDeviceRecord('device-1', {
            activeSession: {} as never,
          }),
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
          makeDeviceRecord('device-1'),
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
          makeDeviceRecord('device-1', {
            activeSession: {} as never,
          }),
        ],
        [
          'device-2',
          makeDeviceRecord('device-2', {
            inactiveSessions: [{} as never],
          }),
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

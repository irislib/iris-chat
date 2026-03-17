import {afterEach, describe, expect, it} from 'vitest'
import {get} from 'svelte/store'
import {devices} from './devices'

describe('devices store', () => {
  afterEach(() => {
    devices.reset()
  })

  it('accepts newer AppKeys updates', () => {
    devices.setRegisteredDevices([{ identityPubkey: 'device-1', createdAt: 100 }], 100)
    devices.setRegisteredDevices(
      [
        { identityPubkey: 'device-1', createdAt: 100 },
        { identityPubkey: 'device-2', createdAt: 101 },
      ],
      101
    )

    expect(get(devices).registeredDevices).toEqual([
      { identityPubkey: 'device-1', createdAt: 100 },
      { identityPubkey: 'device-2', createdAt: 101 },
    ])
    expect(get(devices).lastEventTimestamp).toBe(101)
  })

  it('accepts same-second AppKeys updates as an edge case', () => {
    devices.setRegisteredDevices([{ identityPubkey: 'device-1', createdAt: 100 }], 100)
    devices.setRegisteredDevices(
      [
        { identityPubkey: 'device-1', createdAt: 100 },
        { identityPubkey: 'device-2', createdAt: 100 },
      ],
      100
    )

    expect(get(devices).registeredDevices).toEqual([
      { identityPubkey: 'device-1', createdAt: 100 },
      { identityPubkey: 'device-2', createdAt: 100 },
    ])
    expect(get(devices).lastEventTimestamp).toBe(100)
  })

  it('ignores older AppKeys updates', () => {
    devices.setRegisteredDevices([{ identityPubkey: 'device-2', createdAt: 101 }], 101)
    devices.setRegisteredDevices([{ identityPubkey: 'device-1', createdAt: 100 }], 100)

    expect(get(devices).registeredDevices).toEqual([
      { identityPubkey: 'device-2', createdAt: 101 },
    ])
    expect(get(devices).lastEventTimestamp).toBe(101)
  })
})

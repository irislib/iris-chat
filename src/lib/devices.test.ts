import {afterEach, describe, expect, it} from 'vitest'
import {get} from 'svelte/store'
import {devices, onCurrentDeviceRemovedFromRoster} from './devices'

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
      { identityPubkey: 'device-2', createdAt: 101 },
      { identityPubkey: 'device-1', createdAt: 100 },
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

  it('shows the current device first, then other devices by newest registration', () => {
    devices.setRegisteredDevices(
      [
        { identityPubkey: 'older-device', createdAt: 100 },
        { identityPubkey: 'current-device', createdAt: 101 },
        { identityPubkey: 'newest-device', createdAt: 102 },
      ],
      102
    )
    devices.setIdentityPubkey('current-device')

    expect(get(devices).registeredDevices).toEqual([
      { identityPubkey: 'current-device', createdAt: 101 },
      { identityPubkey: 'newest-device', createdAt: 102 },
      { identityPubkey: 'older-device', createdAt: 100 },
    ])
  })

  it('notifies when a fresh roster removes the current device', () => {
    const removedPubkeys: string[] = []
    const unsubscribe = onCurrentDeviceRemovedFromRoster((pubkey) => {
      removedPubkeys.push(pubkey)
    })

    try {
      devices.setIdentityPubkey('current-device')
      devices.setRegisteredDevices(
        [
          { identityPubkey: 'current-device', createdAt: 100 },
          { identityPubkey: 'other-device', createdAt: 101 },
        ],
        101
      )

      devices.setRegisteredDevices(
        [{ identityPubkey: 'other-device', createdAt: 101 }],
        102
      )

      expect(removedPubkeys).toEqual(['current-device'])
      expect(get(devices).isCurrentDeviceRegistered).toBe(false)
    } finally {
      unsubscribe()
    }
  })

  it('does not notify when an older roster omits the current device', () => {
    const removedPubkeys: string[] = []
    const unsubscribe = onCurrentDeviceRemovedFromRoster((pubkey) => {
      removedPubkeys.push(pubkey)
    })

    try {
      devices.setIdentityPubkey('current-device')
      devices.setRegisteredDevices(
        [
          { identityPubkey: 'current-device', createdAt: 100 },
          { identityPubkey: 'other-device', createdAt: 101 },
        ],
        101
      )

      devices.setRegisteredDevices(
        [{ identityPubkey: 'other-device', createdAt: 100 }],
        100
      )

      expect(removedPubkeys).toEqual([])
      expect(get(devices).isCurrentDeviceRegistered).toBe(true)
    } finally {
      unsubscribe()
    }
  })

  it('does not notify when the current device was never registered', () => {
    const removedPubkeys: string[] = []
    const unsubscribe = onCurrentDeviceRemovedFromRoster((pubkey) => {
      removedPubkeys.push(pubkey)
    })

    try {
      devices.setIdentityPubkey('current-device')
      devices.setRegisteredDevices(
        [{ identityPubkey: 'other-device', createdAt: 100 }],
        100
      )

      expect(removedPubkeys).toEqual([])
      expect(get(devices).isCurrentDeviceRegistered).toBe(false)
    } finally {
      unsubscribe()
    }
  })
})

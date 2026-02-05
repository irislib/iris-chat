import { writable, derived, get } from 'svelte/store'
import type { DeviceEntry } from 'nostr-double-ratchet/dist/nostr-double-ratchet.es.js'

export interface DeviceState {
  identityPubkey: string | null
  registeredDevices: DeviceEntry[]
  isCurrentDeviceRegistered: boolean
  appKeysManagerReady: boolean
  sessionManagerReady: boolean
  hasLocalAppKeys: boolean
  lastEventTimestamp: number
}

const initialState: DeviceState = {
  identityPubkey: null,
  registeredDevices: [],
  isCurrentDeviceRegistered: false,
  appKeysManagerReady: false,
  sessionManagerReady: false,
  hasLocalAppKeys: false,
  lastEventTimestamp: 0,
}

const state = writable<DeviceState>(initialState)

export const devices = {
  subscribe: state.subscribe,
  setIdentityPubkey: (pubkey: string) => {
    const current = get(state)
    const isCurrentDeviceRegistered = current.registeredDevices.some(
      (d) => d.identityPubkey === pubkey
    )
    state.update((s) => ({
      ...s,
      identityPubkey: pubkey,
      isCurrentDeviceRegistered,
    }))
  },
  setRegisteredDevices: (devicesList: DeviceEntry[], timestamp?: number) => {
    state.update((s) => {
      if (timestamp !== undefined && timestamp <= s.lastEventTimestamp) {
        return s
      }
      const isCurrentDeviceRegistered = s.identityPubkey
        ? devicesList.some((d) => d.identityPubkey === s.identityPubkey)
        : false
      return {
        ...s,
        registeredDevices: devicesList,
        isCurrentDeviceRegistered,
        lastEventTimestamp: timestamp ?? s.lastEventTimestamp,
      }
    })
  },
  setAppKeysManagerReady: (ready: boolean) => {
    state.update((s) => ({ ...s, appKeysManagerReady: ready }))
  },
  setSessionManagerReady: (ready: boolean) => {
    state.update((s) => ({ ...s, sessionManagerReady: ready }))
  },
  setHasLocalAppKeys: (has: boolean) => {
    state.update((s) => ({ ...s, hasLocalAppKeys: has }))
  },
  reset: () => state.set(initialState),
}

export const canSendPrivateMessages = derived(state, ($state) => {
  return (
    $state.appKeysManagerReady &&
    $state.sessionManagerReady &&
    ($state.hasLocalAppKeys || $state.isCurrentDeviceRegistered)
  )
})

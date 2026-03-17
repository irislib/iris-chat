import { writable, derived, get } from 'svelte/store'
import {
  evaluateDeviceRegistrationState,
  type DeviceEntry,
} from 'nostr-double-ratchet'

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

function evaluateStateSnapshot(snapshot: {
  identityPubkey: string | null
  registeredDevices: DeviceEntry[]
  appKeysManagerReady: boolean
  sessionManagerReady: boolean
  hasLocalAppKeys: boolean
}) {
  return evaluateDeviceRegistrationState({
    currentDevicePubkey: snapshot.identityPubkey,
    registeredDevices: snapshot.registeredDevices,
    hasLocalAppKeys: snapshot.hasLocalAppKeys,
    appKeysManagerReady: snapshot.appKeysManagerReady,
    sessionManagerReady: snapshot.sessionManagerReady,
  })
}

export const devices = {
  subscribe: state.subscribe,
  setIdentityPubkey: (pubkey: string) => {
    const current = get(state)
    const nextState = evaluateStateSnapshot({
      ...current,
      identityPubkey: pubkey,
    })
    state.update((s) => ({
      ...s,
      identityPubkey: pubkey,
      isCurrentDeviceRegistered: nextState.isCurrentDeviceRegistered,
    }))
  },
  setRegisteredDevices: (devicesList: DeviceEntry[], timestamp?: number) => {
    state.update((s) => {
      if (timestamp !== undefined && timestamp < s.lastEventTimestamp) {
        return s
      }
      const nextState = evaluateStateSnapshot({
        ...s,
        registeredDevices: devicesList,
      })
      return {
        ...s,
        registeredDevices: devicesList,
        isCurrentDeviceRegistered: nextState.isCurrentDeviceRegistered,
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
  return evaluateStateSnapshot($state).canSendPrivateMessages
})

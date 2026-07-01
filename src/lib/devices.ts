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
const currentDeviceRemovalListeners = new Set<(pubkey: string) => void>()

const normalizePubkey = (pubkey: string | null | undefined): string =>
  pubkey?.trim().toLowerCase() || ''

function orderRegisteredDevices(
  devicesList: DeviceEntry[],
  currentDevicePubkey: string | null
): DeviceEntry[] {
  const normalizedCurrent = normalizePubkey(currentDevicePubkey)
  return [...devicesList].sort((left, right) => {
    const leftPubkey = normalizePubkey(left.identityPubkey)
    const rightPubkey = normalizePubkey(right.identityPubkey)
    const leftIsCurrent = normalizedCurrent !== '' && leftPubkey === normalizedCurrent
    const rightIsCurrent = normalizedCurrent !== '' && rightPubkey === normalizedCurrent
    if (leftIsCurrent !== rightIsCurrent) return leftIsCurrent ? -1 : 1
    if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt
    return leftPubkey.localeCompare(rightPubkey)
  })
}

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
      registeredDevices: orderRegisteredDevices(s.registeredDevices, pubkey),
      isCurrentDeviceRegistered: nextState.isCurrentDeviceRegistered,
    }))
  },
  setRegisteredDevices: (devicesList: DeviceEntry[], timestamp?: number) => {
    let removedCurrentDevicePubkey: string | null = null
    state.update((s) => {
      if (timestamp !== undefined && timestamp < s.lastEventTimestamp) {
        return s
      }
      const registeredDevices = orderRegisteredDevices(devicesList, s.identityPubkey)
      const nextState = evaluateStateSnapshot({
        ...s,
        registeredDevices,
      })
      if (
        s.identityPubkey &&
        s.isCurrentDeviceRegistered &&
        !nextState.isCurrentDeviceRegistered
      ) {
        removedCurrentDevicePubkey = s.identityPubkey
      }
      return {
        ...s,
        registeredDevices,
        isCurrentDeviceRegistered: nextState.isCurrentDeviceRegistered,
        lastEventTimestamp: timestamp ?? s.lastEventTimestamp,
      }
    })
    if (removedCurrentDevicePubkey) {
      for (const listener of currentDeviceRemovalListeners) {
        listener(removedCurrentDevicePubkey)
      }
    }
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

export const onCurrentDeviceRemovedFromRoster = (
  listener: (pubkey: string) => void
): (() => void) => {
  currentDeviceRemovalListeners.add(listener)
  return () => {
    currentDeviceRemovalListeners.delete(listener)
  }
}

export const canSendPrivateMessages = derived(state, ($state) => {
  return evaluateStateSnapshot($state).canSendPrivateMessages
})

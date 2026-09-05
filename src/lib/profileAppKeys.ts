import { readable, type Readable } from 'svelte/store'
import {
  AppKeys,
  APP_KEYS_FACT_TYPE,
  APP_KEYS_SNAPSHOT_KIND,
  buildAppKeysFilter,
  type DeviceEntry,
  type NostrSubscribe,
} from 'nostr-double-ratchet'
import type { DeviceLabels } from './deviceLabels'

export const PROFILE_APP_KEYS_KIND = APP_KEYS_SNAPSHOT_KIND
export const PROFILE_APP_KEYS_TYPE = APP_KEYS_FACT_TYPE

export interface ProfileAppKeyDevice extends DeviceEntry {
  labels?: DeviceLabels
}

export interface ProfileAppKeysState {
  devices: ProfileAppKeyDevice[]
  loading: boolean
}

export interface CreateProfileAppKeysStoreOptions {
  subscribe: NostrSubscribe
  timeoutMs?: number
  initialDevices?: DeviceEntry[]
  initialCreatedAt?: number
  initialDeviceLabels?: (identityPubkey: string) => DeviceLabels | undefined
}

export const DEFAULT_PROFILE_APP_KEYS_TIMEOUT_MS = 3000

const cloneDeviceLabels = (labels: DeviceLabels | undefined): DeviceLabels | undefined =>
  labels ? { ...labels } : undefined

const cloneDevices = (
  devices: DeviceEntry[],
  getLabels?: (identityPubkey: string) => DeviceLabels | undefined
): ProfileAppKeyDevice[] =>
  devices.map((device) => {
    const labels = cloneDeviceLabels(getLabels?.(device.identityPubkey))
    return labels ? { ...device, labels } : { ...device }
  })

export const createProfileAppKeysStore = (
  pubkey: string | undefined,
  {
    subscribe,
    timeoutMs = DEFAULT_PROFILE_APP_KEYS_TIMEOUT_MS,
    initialDevices = [],
    initialCreatedAt = 0,
    initialDeviceLabels,
  }: CreateProfileAppKeysStoreOptions
): Readable<ProfileAppKeysState> => {
  const initial = cloneDevices(initialDevices, initialDeviceLabels)

  return readable<ProfileAppKeysState>(
    {
      devices: initial,
      loading: !!pubkey,
    },
    (set) => {
      if (!pubkey) {
        set({
          devices: initial,
          loading: false,
        })
        return () => {}
      }

      let active = true
      let latestDevices = initial
      let latestCreatedAt = initialCreatedAt
      const rosterKey = (devices: DeviceEntry[]) => JSON.stringify([...new Set(devices.map(device => device.identityPubkey))].sort())
      let latestRoster = rosterKey(initial)
      let conflicting = false
      const stop = subscribe(buildAppKeysFilter(pubkey), (event) => {
        if (!active || event.pubkey !== pubkey || event.created_at < latestCreatedAt ||
          event.created_at > Math.floor(Date.now() / 1000) + 300) return
        try {
          const devices = AppKeys.fromEvent(event).getAllDevices()
          const incomingRoster = rosterKey(devices)
          if (event.created_at === latestCreatedAt) {
            conflicting ||= incomingRoster !== latestRoster
          } else {
            conflicting = false
          }
          latestCreatedAt = event.created_at
          latestRoster = incomingRoster
          latestDevices = conflicting ? [] : cloneDevices(devices, initialDeviceLabels)
          set({
            devices: latestDevices,
            loading: false,
          })
        } catch {
          // Ignore unrelated or invalid fact snapshots.
        }
      })

      const timeout = setTimeout(() => {
        if (!active) return
        set({
          devices: latestDevices,
          loading: false,
        })
      }, timeoutMs)

      return () => {
        active = false
        clearTimeout(timeout)
        stop()
      }
    }
  )
}

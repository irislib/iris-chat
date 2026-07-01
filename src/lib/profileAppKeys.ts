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
      const stop = subscribe(buildAppKeysFilter(pubkey), (event) => {
        if (!active || event.pubkey !== pubkey) return
        try {
          latestDevices = cloneDevices(AppKeys.fromEvent(event).getAllDevices(), initialDeviceLabels)
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

import { readable, type Readable } from 'svelte/store'
import { AppKeys, type DeviceEntry, type NostrSubscribe } from 'nostr-double-ratchet'

export interface ProfileAppKeysState {
  devices: DeviceEntry[]
  loading: boolean
}

export interface CreateProfileAppKeysStoreOptions {
  subscribe: NostrSubscribe
  timeoutMs?: number
  initialDevices?: DeviceEntry[]
}

export const DEFAULT_PROFILE_APP_KEYS_TIMEOUT_MS = 3000

const cloneDevices = (devices: DeviceEntry[]): DeviceEntry[] => devices.map((device) => ({ ...device }))

export const createProfileAppKeysStore = (
  pubkey: string | undefined,
  { subscribe, timeoutMs = DEFAULT_PROFILE_APP_KEYS_TIMEOUT_MS, initialDevices = [] }: CreateProfileAppKeysStoreOptions
): Readable<ProfileAppKeysState> => {
  const initial = cloneDevices(initialDevices)

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

      const stop = AppKeys.fromUser(pubkey, subscribe, (appKeys) => {
        latestDevices = cloneDevices(appKeys.getAllDevices())
        set({
          devices: latestDevices,
          loading: false,
        })
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

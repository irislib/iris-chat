import { readable, type Readable } from 'svelte/store'
import { AppKeys, type DeviceEntry, type NostrSubscribe } from 'nostr-double-ratchet'
import type { DeviceLabels } from './deviceLabels'

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
  ownerPrivateKey?: Uint8Array | null
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
    ownerPrivateKey,
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

      const stop = AppKeys.fromUser(pubkey, subscribe, (appKeys) => {
        latestDevices = cloneDevices(
          appKeys.getAllDevices(),
          (identityPubkey) => appKeys.getDeviceLabels(identityPubkey)
        )
        set({
          devices: latestDevices,
          loading: false,
        })
      }, ownerPrivateKey ?? undefined)

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

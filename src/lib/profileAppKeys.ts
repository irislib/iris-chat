import { readable, type Readable } from 'svelte/store'
import {
  IDENTITY_GRAPH_ROSTER_TYPE,
  KIND_NOSTR_IDENTITY_ROSTER_OP,
  type NostrIdentityFacet,
  type SignedNostrIdentityRosterOp,
} from '@iris/identity/profile'
import { parseNostrIdentityRosterOpEvent } from '@iris/identity/profileEvents'
import { projectNostrIdentityRoster } from '@iris/identity/profileProjection'
import type { DeviceEntry, NostrSubscribe } from 'nostr-double-ratchet'
import type { DeviceLabels } from './deviceLabels'

export const NOSTR_IDENTITY_ROSTER_OP_KIND = KIND_NOSTR_IDENTITY_ROSTER_OP
export const NOSTR_IDENTITY_ROSTER_TYPE = IDENTITY_GRAPH_ROSTER_TYPE

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
  initialRosterOps?: SignedNostrIdentityRosterOp[]
  nostrIdentityId?: string | null
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

const isNostrIdentityRosterOpEvent = (event: {
  kind: number
  tags: string[][]
}): boolean =>
  event.kind === NOSTR_IDENTITY_ROSTER_OP_KIND &&
  event.tags.some((tag) => tag[0] === 'type' && tag[1] === NOSTR_IDENTITY_ROSTER_TYPE)

const buildNostrIdentityRosterFilter = (profileId: string) => ({
  kinds: [NOSTR_IDENTITY_ROSTER_OP_KIND],
  '#i': [profileId],
})

const isAppKeyFacet = (facet: NostrIdentityFacet): boolean =>
  facet.purposes?.includes('app_key') ?? false

const projectRosterDevices = (
  profileId: string,
  rosterOps: SignedNostrIdentityRosterOp[]
): ProfileAppKeyDevice[] => {
  const projection = projectNostrIdentityRoster(profileId, rosterOps)
  return Object.values(projection.active_facets)
    .filter(isAppKeyFacet)
    .sort((a, b) => a.added_at - b.added_at || a.pubkey.localeCompare(b.pubkey))
    .map((facet) => ({
      identityPubkey: facet.pubkey,
      createdAt: facet.added_at,
    }))
}

const parseRosterOpEvent = (
  profileId: string,
  event: Parameters<NostrSubscribe>[1] extends (event: infer E) => void ? E : never
): SignedNostrIdentityRosterOp | null => {
  if (!isNostrIdentityRosterOpEvent(event)) return null
  try {
    const rosterOp = parseNostrIdentityRosterOpEvent(event)
    return rosterOp.content.profile_id === profileId ? rosterOp : null
  } catch {
    return null
  }
}

export const createProfileAppKeysStore = (
  pubkey: string | undefined,
  {
    subscribe,
    timeoutMs = DEFAULT_PROFILE_APP_KEYS_TIMEOUT_MS,
    initialDevices = [],
    initialDeviceLabels,
    initialRosterOps = [],
    nostrIdentityId,
  }: CreateProfileAppKeysStoreOptions
): Readable<ProfileAppKeysState> => {
  const initial = nostrIdentityId
    ? projectRosterDevices(nostrIdentityId, initialRosterOps)
    : cloneDevices(initialDevices, initialDeviceLabels)

  return readable<ProfileAppKeysState>(
    {
      devices: initial,
      loading: !!nostrIdentityId,
    },
    (set) => {
      if (!nostrIdentityId) {
        set({
          devices: initial,
          loading: false,
        })
        return () => {}
      }

      let active = true
      let latestDevices = initial
      const rosterOps = initialRosterOps.slice()
      const seenOpIds = new Set(rosterOps.map((op) => op.op_id))
      const stop = subscribe(buildNostrIdentityRosterFilter(nostrIdentityId), (event) => {
        if (!active) return
        const rosterOp = parseRosterOpEvent(nostrIdentityId, event)
        if (!rosterOp || seenOpIds.has(rosterOp.op_id)) return
        seenOpIds.add(rosterOp.op_id)
        rosterOps.push(rosterOp)
        latestDevices = projectRosterDevices(nostrIdentityId, rosterOps)
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

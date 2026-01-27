/**
 * Relay Store - tracks relay configuration and connection status
 */
import { writable, derived, get } from 'svelte/store'
import type NDK from '@nostr-dev-kit/ndk'
import { NDKRelayStatus } from '@nostr-dev-kit/ndk'

export type RelayStatus = 'disconnected' | 'connecting' | 'connected'

export interface RelayState {
  relays: Set<string>
  statuses: Map<string, RelayStatus>
  connectedCount: number
  showConnectivity: boolean
}

const RELAYS_STORAGE_KEY = 'iris-chat-relays'
const SHOW_CONNECTIVITY_KEY = 'iris-chat-show-connectivity'

// Normalize relay URL (remove trailing slash)
function normalizeRelayUrl(url: string): string {
  return url.replace(/\/$/, '')
}

export const DEFAULT_RELAYS = [
  'wss://relay.primal.net',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://temp.iris.to',
  'wss://offchain.pub',
]

function loadRelays(): Set<string> {
  try {
    const stored = localStorage.getItem(RELAYS_STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return new Set(parsed)
      }
    }
  } catch {
    // ignore
  }
  return new Set(DEFAULT_RELAYS)
}

function saveRelays(relays: Set<string>): void {
  try {
    localStorage.setItem(RELAYS_STORAGE_KEY, JSON.stringify([...relays]))
  } catch {
    // ignore
  }
}

function loadShowConnectivity(): boolean {
  try {
    const stored = localStorage.getItem(SHOW_CONNECTIVITY_KEY)
    return stored !== 'false' // default to true
  } catch {
    return true
  }
}

function saveShowConnectivity(show: boolean): void {
  try {
    localStorage.setItem(SHOW_CONNECTIVITY_KEY, String(show))
  } catch {
    // ignore
  }
}

function createRelayStore() {
  const initialRelays = loadRelays()
  const { subscribe, update, set } = writable<RelayState>({
    relays: initialRelays,
    statuses: new Map([...initialRelays].map(url => [url, 'disconnected' as RelayStatus])),
    connectedCount: 0,
    showConnectivity: loadShowConnectivity(),
  })

  return {
    subscribe,

    setRelays(relays: Set<string>) {
      saveRelays(relays)
      update(state => {
        const newStatuses = new Map<string, RelayStatus>()
        for (const url of relays) {
          newStatuses.set(url, state.statuses.get(url) || 'disconnected')
        }
        return { ...state, relays, statuses: newStatuses }
      })
    },

    addRelay(url: string) {
      update(state => {
        if (state.relays.has(url)) return state
        const newRelays = new Set(state.relays)
        newRelays.add(url)
        saveRelays(newRelays)
        const newStatuses = new Map(state.statuses)
        newStatuses.set(url, 'disconnected')
        return { ...state, relays: newRelays, statuses: newStatuses }
      })
    },

    removeRelay(url: string) {
      update(state => {
        const newRelays = new Set(state.relays)
        newRelays.delete(url)
        saveRelays(newRelays)
        const newStatuses = new Map(state.statuses)
        newStatuses.delete(url)
        return { ...state, relays: newRelays, statuses: newStatuses }
      })
    },

    resetToDefaults() {
      const defaults = new Set(DEFAULT_RELAYS)
      saveRelays(defaults)
      update(state => ({
        ...state,
        relays: defaults,
        statuses: new Map(DEFAULT_RELAYS.map(url => [url, 'disconnected' as RelayStatus])),
        connectedCount: 0,
      }))
    },

    setShowConnectivity(show: boolean) {
      saveShowConnectivity(show)
      update(state => ({ ...state, showConnectivity: show }))
    },

    updateStatuses(ndk: NDK) {
      update(state => {
        const newStatuses = new Map<string, RelayStatus>()
        let connected = 0

        // Normalize configured relay URLs for comparison
        const normalizedConfigured = new Map<string, string>()
        for (const url of state.relays) {
          normalizedConfigured.set(normalizeRelayUrl(url), url)
          newStatuses.set(url, 'disconnected')
        }

        // Update from pool - iterate over actual connected relays
        for (const relay of ndk.pool.relays.values()) {
          const normalizedUrl = normalizeRelayUrl(relay.url)
          const configuredUrl = normalizedConfigured.get(normalizedUrl)
          if (!configuredUrl) continue

          // NDKRelayStatus.CONNECTED = 5, also count AUTH states (6, 7, 8)
          if (relay.status >= NDKRelayStatus.CONNECTED) {
            newStatuses.set(configuredUrl, 'connected')
            connected++
          } else if (relay.status === NDKRelayStatus.CONNECTING || relay.status === NDKRelayStatus.RECONNECTING) {
            newStatuses.set(configuredUrl, 'connecting')
          } else {
            newStatuses.set(configuredUrl, 'disconnected')
          }
        }

        return { ...state, statuses: newStatuses, connectedCount: connected }
      })
    },

    getState(): RelayState {
      return get({ subscribe })
    },
  }
}

export const relayStore = createRelayStore()

export const connectedRelayCount = derived(relayStore, $store => $store.connectedCount)
export const configuredRelays = derived(relayStore, $store => [...$store.relays])

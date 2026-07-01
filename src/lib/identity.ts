import NDK, { NDKPrivateKeySigner, NDKNip07Signer } from '@nostr-dev-kit/ndk'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { writable, derived, get } from 'svelte/store'
import {
  saveLocalProfile,
  clearLocalProfile,
  getLocalProfile,
  updateLocalProfile,
  type Profile,
} from './profile'
import { relayStore } from './relayStore'

// Helper functions
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export interface Identity {
  pubkey: string
  signer?: NDKPrivateKeySigner | NDKNip07Signer
  displayName: string | null
  isNip07: boolean
  isLinkedDevice?: boolean
}

const IDENTITY_STORAGE_KEY = 'iris-chat-identity'
const LINKED_IDENTITY_PREFIX = 'link:'

export const identity = writable<Identity | null>(null)

export const isLoggedIn = derived(identity, $identity => $identity !== null)

// Create NDK instance with relays from store
const initialRelays = [...relayStore.getState().relays]
const ndkInstance = new NDK({
  explicitRelayUrls: initialRelays,
})
ndkInstance.connect()

export const ndk = writable<NDK>(ndkInstance)

// Start relay status polling
function initRelayTracking() {
  // Poll immediately
  relayStore.updateStatuses(ndkInstance)

  // Fast polling for first 5 seconds
  let pollCount = 0
  const fastPoll = setInterval(() => {
    pollCount++
    relayStore.updateStatuses(ndkInstance)
    if (pollCount >= 25) clearInterval(fastPoll)
  }, 200)

  // Regular polling
  setInterval(() => relayStore.updateStatuses(ndkInstance), 2000)
}

initRelayTracking()

// Reconnect NDK when relays change
let previousRelays = new Set(initialRelays)
relayStore.subscribe(state => {
  const newUrls = state.relays

  // Skip if relays haven't actually changed (prevents initial subscription trigger)
  if (previousRelays.size === newUrls.size && [...previousRelays].every(url => newUrls.has(url))) {
    return
  }

  // Disconnect removed relays
  for (const url of previousRelays) {
    if (!newUrls.has(url)) {
      const relay = ndkInstance.pool.relays.get(url)
      relay?.disconnect()
      ndkInstance.pool.relays.delete(url)
    }
  }
  // Add new relays
  for (const url of newUrls) {
    if (!previousRelays.has(url)) {
      ndkInstance.addExplicitRelay(url)
    }
  }

  previousRelays = new Set(newUrls)
})

export function parseNsecFromHash(): string | null {
  const hash = window.location.hash
  if (!hash || hash.length < 2) return null

  const nsec = hash.slice(1)
  if (!nsec.startsWith('nsec1')) return null

  try {
    const decoded = nip19.decode(nsec)
    if (decoded.type === 'nsec') {
      return bytesToHex(decoded.data as Uint8Array)
    }
  } catch {
    return null
  }
  return null
}

export function generateNewIdentity(): { privkey: string; pubkey: string; nsec: string } {
  const privkeyBytes = generateSecretKey()
  const privkey = bytesToHex(privkeyBytes)
  const pubkey = getPublicKey(privkeyBytes)
  const nsec = nip19.nsecEncode(privkeyBytes)
  return { privkey, pubkey, nsec }
}

export function loadStoredIdentity(): string | null {
  try {
    return localStorage.getItem(IDENTITY_STORAGE_KEY)
  } catch {
    return null
  }
}

export function saveIdentity(privkeyHex: string): void {
  try {
    localStorage.setItem(IDENTITY_STORAGE_KEY, privkeyHex)
  } catch {
    console.warn('Failed to save identity to localStorage')
  }
}

export function saveLinkedIdentity(ownerPubkey: string): void {
  try {
    localStorage.setItem(IDENTITY_STORAGE_KEY, `${LINKED_IDENTITY_PREFIX}${ownerPubkey}`)
  } catch {
    console.warn('Failed to save linked identity to localStorage')
  }
}

export function clearStoredIdentity(): void {
  try {
    localStorage.removeItem(IDENTITY_STORAGE_KEY)
  } catch {
    console.warn('Failed to clear identity from localStorage')
  }
}

export async function loginWithPrivkey(privkeyHex: string, displayName: string | null = null): Promise<void> {
  const signer = new NDKPrivateKeySigner(privkeyHex)
  const user = await signer.user()

  // Set signer on existing NDK instance
  ndkInstance.signer = signer

  identity.set({
    pubkey: user.pubkey,
    signer,
    displayName,
    isNip07: false,
    isLinkedDevice: false,
  })

  // Save local profile and publish to Nostr
  if (displayName) {
    saveLocalProfile(user.pubkey, displayName)

    // Publish kind 0 profile event to relays
    const ndkUser = ndkInstance.getUser({ pubkey: user.pubkey })
    ndkUser.profile = { name: displayName, displayName: displayName }
    await ndkUser.publish().catch(err => console.error('[identity] failed to publish profile:', err))
  }

  saveIdentity(privkeyHex)
}

export async function loginWithNip07(displayName: string | null = null): Promise<void> {
  // Wait briefly for NIP-07 injection (handles slow extension/mocked environments)
  for (let i = 0; i < 10; i++) {
    if (hasNip07()) break
    await new Promise((r) => setTimeout(r, 200))
  }
  if (!window.nostr) {
    throw new Error('No NIP-07 extension found')
  }

  const signer = new NDKNip07Signer(5000)
  let user = await signer.user().catch(async (err) => {
    const pubkey = await window.nostr?.getPublicKey?.()
    if (!pubkey) throw err
    // Fallback: manually seed signer state for mocked NIP-07 environments
    ;(signer as unknown as { _pubkey?: string })._pubkey = pubkey
    const ndkUser = ndkInstance.getUser({ pubkey })
    ;(signer as unknown as { _user?: typeof ndkUser })._user = ndkUser
    return ndkUser
  })

  // Set signer on existing NDK instance
  ndkInstance.signer = signer

  identity.set({
    pubkey: user.pubkey,
    signer,
    displayName,
    isNip07: true,
    isLinkedDevice: false,
  })

  // Save local profile and publish to Nostr if name provided
  if (displayName) {
    saveLocalProfile(user.pubkey, displayName)

    // Publish kind 0 profile event to relays
    const ndkUser = ndkInstance.getUser({ pubkey: user.pubkey })
    ndkUser.profile = { name: displayName, displayName: displayName }
    await ndkUser.publish().catch(err => console.error('[identity] failed to publish profile:', err))
  }

  // Save marker to remember NIP-07 login
  saveIdentity('nip07')
}

export async function loginLinkedDevice(
  ownerPubkey: string,
  displayName: string | null = null
): Promise<void> {
  ndkInstance.signer = undefined

  identity.set({
    pubkey: ownerPubkey,
    signer: undefined,
    displayName,
    isNip07: false,
    isLinkedDevice: true,
  })

  saveLinkedIdentity(ownerPubkey)
}

export async function autoLogin(displayName: string | null = null): Promise<boolean> {
  // Check for stored identity (user's own identity, NOT from URL hash)
  // URL hash contains meeting nsec, not user identity
  const storedValue = loadStoredIdentity()
  if (storedValue) {
    // Restore displayName from local profile if not provided
    if (!displayName) {
      const localProfile = getLocalProfile()
      displayName = localProfile?.display_name || localProfile?.name || null
    }

    if (storedValue.startsWith(LINKED_IDENTITY_PREFIX)) {
      const ownerPubkey = storedValue.slice(LINKED_IDENTITY_PREFIX.length)
      if (ownerPubkey && ownerPubkey.length === 64) {
        await loginLinkedDevice(ownerPubkey, displayName)
        return true
      }
      return false
    }

    if (storedValue === 'nip07') {
      // Wait for NIP-07 extension to inject window.nostr
      for (let i = 0; i < 10; i++) {
        if (hasNip07()) break
        await new Promise((r) => setTimeout(r, 200))
      }
      if (hasNip07()) {
        try {
          await loginWithNip07(displayName)
          return true
        } catch {
          return false
        }
      }
      return false
    } else {
      // It's a privkey
      await loginWithPrivkey(storedValue, displayName)
      return true
    }
  }

  return false
}

export function logout(): void {
  const currentIdentity = get(identity)
  ndkInstance.signer = undefined
  identity.set(null)
  clearStoredIdentity()
  clearLocalProfile()
}

export async function updateOwnProfile(input: {
  name?: string
  picture?: string
  baseProfile?: Profile
}): Promise<Profile> {
  const currentIdentity = get(identity)
  if (!currentIdentity) {
    throw new Error('Not logged in')
  }

  const name = input.name?.trim()
  const picture = input.picture?.trim()

  if (input.name !== undefined && !name) {
    throw new Error('Name cannot be empty')
  }
  if (input.picture !== undefined && !picture) {
    throw new Error('Picture URL cannot be empty')
  }
  if (input.name === undefined && input.picture === undefined) {
    throw new Error('No profile changes provided')
  }

  const base =
    input.baseProfile && input.baseProfile.pubkey === currentIdentity.pubkey
      ? input.baseProfile
      : (getLocalProfile() ?? { pubkey: currentIdentity.pubkey })

  const patch: Partial<Omit<Profile, 'pubkey'>> = {}
  if (base.name !== undefined) patch.name = base.name
  if (base.display_name !== undefined) patch.display_name = base.display_name
  if (base.username !== undefined) patch.username = base.username
  if (base.picture !== undefined) patch.picture = base.picture
  if (base.nip05 !== undefined) patch.nip05 = base.nip05
  if (base.about !== undefined) patch.about = base.about

  if (name) {
    patch.name = name
    patch.display_name = name
  }
  if (picture) {
    patch.picture = picture
  }

  const updatedProfile = updateLocalProfile(currentIdentity.pubkey, patch)

  identity.update((value) => {
    if (!value || value.pubkey !== currentIdentity.pubkey) return value
    return {
      ...value,
      displayName: updatedProfile.display_name || updatedProfile.name || null,
    }
  })

  const ndkProfile: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(updatedProfile)) {
    if (key === 'pubkey' || value === undefined) continue
    if (key === 'display_name') {
      ndkProfile.displayName = value
      continue
    }
    ndkProfile[key] = value
  }

  const ndkUser = ndkInstance.getUser({ pubkey: currentIdentity.pubkey })
  ndkUser.profile = ndkProfile
  await ndkUser.publish()

  return updatedProfile
}

export function hasNip07(): boolean {
  return typeof window !== 'undefined' && !!window.nostr
}

export function hasNip44Support(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.nostr?.nip44?.encrypt === 'function' &&
    typeof window.nostr?.nip44?.decrypt === 'function'
  )
}

// Get the private key hex from current identity (only works for non-NIP07)
export function getPrivkeyHex(): string | null {
  const currentIdentity = get(identity)
  if (!currentIdentity || currentIdentity.isNip07 || !currentIdentity.signer) return null

  const signer = currentIdentity.signer as NDKPrivateKeySigner
  return signer.privateKey || null
}

export function getPrivkeyBytes(): Uint8Array | null {
  const hex = getPrivkeyHex()
  if (!hex) return null
  return hexToBytes(hex)
}

export function getPubkey(): string | null {
  const currentIdentity = get(identity)
  if (!currentIdentity) return null
  return currentIdentity.pubkey
}

export function isNip07Login(): boolean {
  const currentIdentity = get(identity)
  return currentIdentity?.isNip07 ?? false
}

export function isLinkedDeviceLogin(): boolean {
  const currentIdentity = get(identity)
  return currentIdentity?.isLinkedDevice ?? false
}

// Window.nostr type is provided by nostr-tools/nip07
// We just need to declare it exists on window for TypeScript
declare const window: Window & { nostr?: import('nostr-tools/nip07').WindowNostr }

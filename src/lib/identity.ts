import NDK, { NDKPrivateKeySigner, NDKNip07Signer } from '@nostr-dev-kit/ndk'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { writable, derived, get } from 'svelte/store'
import { saveLocalProfile, clearLocalProfile, getLocalProfile } from './profile'

// Helper functions
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export interface Identity {
  pubkey: string
  signer: NDKPrivateKeySigner | NDKNip07Signer
  displayName: string | null
  isNip07: boolean
}

const IDENTITY_STORAGE_KEY = 'iris-chat-identity'

export const identity = writable<Identity | null>(null)

export const isLoggedIn = derived(identity, $identity => $identity !== null)

const DEFAULT_RELAYS = [
  'wss://temp.iris.to',
  'wss://relay.damus.io',
  'wss://relay.snort.social',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://nos.lol',
]

// Create NDK instance immediately and start connecting
const ndkInstance = new NDK({
  explicitRelayUrls: DEFAULT_RELAYS,
})
ndkInstance.connect()

export const ndk = writable<NDK>(ndkInstance)

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
  })

  // Save local profile and publish to Nostr
  if (displayName) {
    saveLocalProfile(user.pubkey, displayName)

    // Publish kind 0 profile event to relays
    const ndkUser = ndkInstance.getUser({ pubkey: user.pubkey })
    ndkUser.profile = { name: displayName, displayName: displayName }
    ndkUser.publish().catch(err => console.error('[identity] failed to publish profile:', err))
  }

  saveIdentity(privkeyHex)
}

export async function loginWithNip07(displayName: string | null = null): Promise<void> {
  if (!window.nostr) {
    throw new Error('No NIP-07 extension found')
  }

  const signer = new NDKNip07Signer()
  const user = await signer.user()

  // Set signer on existing NDK instance
  ndkInstance.signer = signer

  identity.set({
    pubkey: user.pubkey,
    signer,
    displayName,
    isNip07: true,
  })

  // Save local profile and publish to Nostr if name provided
  if (displayName) {
    saveLocalProfile(user.pubkey, displayName)

    // Publish kind 0 profile event to relays
    const ndkUser = ndkInstance.getUser({ pubkey: user.pubkey })
    ndkUser.profile = { name: displayName, displayName: displayName }
    ndkUser.publish().catch(err => console.error('[identity] failed to publish profile:', err))
  }

  // Save marker to remember NIP-07 login
  saveIdentity('nip07')
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

    if (storedValue === 'nip07') {
      // Try to re-authenticate with NIP-07 extension
      if (hasNip07()) {
        try {
          await loginWithNip07(displayName)
          return true
        } catch {
          // Extension may have been removed or user denied access
          clearStoredIdentity()
          return false
        }
      } else {
        // Extension no longer available
        clearStoredIdentity()
        return false
      }
    } else {
      // It's a privkey
      await loginWithPrivkey(storedValue, displayName)
      return true
    }
  }

  return false
}

export function logout(): void {
  ndkInstance.signer = undefined
  identity.set(null)
  clearStoredIdentity()
  clearLocalProfile()
}

export function hasNip07(): boolean {
  return typeof window !== 'undefined' && !!window.nostr
}

// Get the private key hex from current identity (only works for non-NIP07)
export function getPrivkeyHex(): string | null {
  const currentIdentity = get(identity)
  if (!currentIdentity || currentIdentity.isNip07) return null

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

declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>
      signEvent(event: any): Promise<any>
      nip04?: {
        encrypt(pubkey: string, plaintext: string): Promise<string>
        decrypt(pubkey: string, ciphertext: string): Promise<string>
      }
      nip44?: {
        encrypt(pubkey: string, plaintext: string): Promise<string>
        decrypt(pubkey: string, ciphertext: string): Promise<string>
      }
    }
  }
}

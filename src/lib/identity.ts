import { buildProfileDraft } from '@iris/profile-events'
import { signedProfileHeads } from './deviceSyncRecordStore'
import { verifiedProfileEvent } from './deviceSyncRecords'
import NostrClient, { AppEvent, SecretKeySigner, ExtensionSigner } from './nostrClient'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { writable, derived, get } from 'svelte/store'
import {
  saveLocalProfile,
  clearLocalProfile,
  getLocalProfile,
  observeSignedProfile,
  type Profile,
} from './profile'
import { relayStore, getPublicRelays } from './relayStore'

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
  signer?: SecretKeySigner | ExtensionSigner
  displayName: string | null
  isNip07: boolean
  isLinkedDevice?: boolean
  freshlyGenerated?: boolean
}

const IDENTITY_STORAGE_KEY = 'iris-chat-identity'
const LINKED_IDENTITY_PREFIX = 'link:'

export const identity = writable<Identity | null>(null)

export const isLoggedIn = derived(identity, $identity => $identity !== null)

// Create NostrClient instance with relays from store
const initialPolicy = relayStore.getState()
const initialRelays = getPublicRelays(initialPolicy)
const client = new NostrClient({
  explicitRelayUrls: initialRelays,
  privateRelayUrls: [...initialPolicy.relays],
})

export const nostrClient = writable<NostrClient>(client)

// Start relay status polling
function initRelayTracking() {
  // Poll immediately
  relayStore.updateStatuses(client)

  // Fast polling for first 5 seconds
  let pollCount = 0
  const fastPoll = setInterval(() => {
    pollCount++
    relayStore.updateStatuses(client)
    if (pollCount >= 25) clearInterval(fastPoll)
  }, 200)

  // Regular polling
  setInterval(() => relayStore.updateStatuses(client), 2000)
}

initRelayTracking()

// Reconnect NostrClient when relays change
let previousPolicy = JSON.stringify([initialRelays, [...initialPolicy.relays]])
relayStore.subscribe(state => {
  const publicRelays = getPublicRelays(state), privateRelays = [...state.relays]
  const policy = JSON.stringify([publicRelays, privateRelays])
  if (previousPolicy === policy) return
  client.setRelays(publicRelays, privateRelays)
  previousPolicy = policy
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

export async function loginWithPrivkey(privkeyHex: string, displayName: string | null = null,
  freshlyGenerated = false): Promise<void> {
  const signer = new SecretKeySigner(privkeyHex)
  const user = await signer.user()

  // Set signer on existing NostrClient instance
  client.runtime.setAccount(user.pubkey)
  client.signer = signer

  identity.set({
    pubkey: user.pubkey,
    signer,
    displayName,
    isNip07: false,
    isLinkedDevice: false,
    freshlyGenerated,
  })

  if (freshlyGenerated && displayName) {
    saveLocalProfile(user.pubkey, displayName)
    const event = new AppEvent(client, buildProfileDraft(null, { name: displayName, display_name: displayName }))
    void event.sign(signer).then(async () => {
      if (get(identity)?.pubkey !== user.pubkey) return
      await event.publish()
      await observeSignedProfile(event.rawEvent())
    }).catch(err => console.error('[identity] failed to publish new profile:', err))
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

  const signer = new ExtensionSigner(5000)
  const user = await signer.user()

  // Set signer on existing NostrClient instance
  client.runtime.setAccount(user.pubkey)
  client.signer = signer

  identity.set({
    pubkey: user.pubkey,
    signer,
    displayName,
    isNip07: true,
    isLinkedDevice: false,
  })

  // Save marker to remember NIP-07 login
  saveIdentity('nip07')
}

export async function loginLinkedDevice(
  ownerPubkey: string,
  displayName: string | null = null
): Promise<void> {
  client.runtime.setAccount(ownerPubkey)
  client.signer = undefined

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
  client.runtime.setAccount()
  client.signer = undefined
  identity.set(null)
  clearStoredIdentity()
  clearLocalProfile()
}

type ProfileEdit = { name?: string; picture?: string; baseProfile?: Profile }
let profileWriter: Promise<unknown> = Promise.resolve()

export function updateOwnProfile(input: ProfileEdit): Promise<Profile> {
  const account = get(identity)
  const next = profileWriter.then(() => {
    if (get(identity)?.signer !== account?.signer) throw new Error('Account changed')
    return saveProfileEdit(input, account)
  })
  profileWriter = next.catch(() => {})
  return next
}

async function saveProfileEdit(input: ProfileEdit, currentIdentity: Identity | null): Promise<Profile> {
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

  const { pubkey, signer } = currentIdentity
  if (!signer) throw new Error('Edit your profile on your main device')
  const filter = [{ kinds: [0], authors: [pubkey], limit: 1 }]
  const [local, cached, remote] = await Promise.all([
    signedProfileHeads(pubkey, new Set([pubkey])),
    client.runtime.query(filter, { cache: 'cache-only' }),
    client.runtime.query(filter, { cache: 'network-only' }),
  ])
  const candidates = [...local, ...cached.events, ...remote.events]
    .filter(event => event.pubkey === pubkey && event.kind === 0)
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
  const head = candidates[0] ? verifiedProfileEvent(candidates[0]) : null
  if ((candidates.length && !head) || (!head && (!remote.complete || remote.reason !== 'eose' || !remote.sources.length))) {
    throw new Error('Could not read your full public profile. Try again once a relay is available.')
  }
  const shown = input.baseProfile
  if (shown?.eventId && shown.pubkey === pubkey && shown.eventId !== head?.id) {
    if (!head || (shown.eventCreatedAt ?? 0) > head.created_at ||
        (shown.eventCreatedAt === head.created_at && shown.eventId < head.id)) {
      throw new Error('Your latest public profile is missing. Refresh your profile and try again.')
    }
    const latest = JSON.parse(head.content)
    if ((name && ((shown.name ?? '') !== (latest.name ?? '') ||
          (shown.display_name ?? shown.name ?? '') !== (latest.display_name ?? latest.name ?? ''))) ||
        (picture && (shown.picture ?? '') !== (latest.picture ?? ''))) {
      await observeSignedProfile(head)
      throw new Error('This field changed elsewhere. Review the latest profile and save again.')
    }
  }

  const patch = { ...(name && { name, display_name: name }), ...(picture && { picture }) }
  const event = new AppEvent(client, buildProfileDraft(head ?? null, patch))
  if (get(identity)?.signer !== signer || (await signer.user()).pubkey !== pubkey) throw new Error('Account changed')
  await event.sign(signer)
  if (event.pubkey !== pubkey || !verifiedProfileEvent(event.rawEvent())) {
    throw new Error('This signed profile exceeds the supported size or is invalid.')
  }
  const [newest] = await signedProfileHeads(pubkey, new Set([pubkey]))
  if (get(identity)?.signer !== signer) throw new Error('Account changed')
  if (newest && (!head || newest.created_at > head.created_at ||
      newest.created_at === head.created_at && newest.id < head.id)) {
    throw new Error('Your profile changed while signing. Review it and save again.')
  }
  await event.publish()
  if (get(identity)?.signer !== signer) throw new Error('Account changed')
  const updatedProfile = await observeSignedProfile(event.rawEvent(), true)
  if (!updatedProfile) throw new Error('Could not save your signed profile on this device.')
  identity.update(value => value?.pubkey === pubkey
    ? { ...value, displayName: updatedProfile.display_name || updatedProfile.name || null } : value)

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

  const signer = currentIdentity.signer as SecretKeySigner
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

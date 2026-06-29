import { writable, get } from 'svelte/store'
import {
  DEFAULT_NOSTR_IDENTITY_SESSION_STORAGE_KEY,
  clearNostrIdentitySession,
  createLocalNostrIdentitySession,
  loadNostrIdentitySession,
  publishNostrIdentitySessionRosterEvents,
  saveNostrIdentitySession,
  type NostrIdentityEventPublisher,
  type NostrIdentitySession,
  type NostrIdentitySessionStorage,
} from '@iris/identity/session'
import type { NostrIdentityId } from '@iris/identity/profile'
import {
  createNostrIdentitySignerFromNsec,
  type NostrIdentityEventSigner,
} from '@iris/identity/signers'

export const nostrIdentitySession = writable<NostrIdentitySession | null>(null)

interface NostrIdentityBrowserSessionStoreOptions {
  storage?: NostrIdentitySessionStorage | null
}

interface EnsureNostrIdentityBrowserSessionOptions extends NostrIdentityBrowserSessionStoreOptions {
  profileId?: NostrIdentityId
  appKeySecretKey?: Uint8Array
  createdAt?: number
  clientNonce?: string
  label?: string
}

const normalizeOwnerPubkey = (ownerPubkey: string): string => ownerPubkey.trim().toLowerCase()

export const nostrIdentitySessionStorageKey = (ownerPubkey: string): string =>
  `${DEFAULT_NOSTR_IDENTITY_SESSION_STORAGE_KEY}:iris-chat:${normalizeOwnerPubkey(ownerPubkey)}`

export const loadNostrIdentityBrowserSession = (
  ownerPubkey: string,
  options: NostrIdentityBrowserSessionStoreOptions = {}
): NostrIdentitySession | null => {
  const session = loadNostrIdentitySession({
    storage: options.storage,
    key: nostrIdentitySessionStorageKey(ownerPubkey),
  })
  nostrIdentitySession.set(session)
  return session
}

export const saveNostrIdentityBrowserSession = (
  ownerPubkey: string,
  session: NostrIdentitySession,
  options: NostrIdentityBrowserSessionStoreOptions = {}
): void => {
  saveNostrIdentitySession(session, {
    storage: options.storage,
    key: nostrIdentitySessionStorageKey(ownerPubkey),
  })
  nostrIdentitySession.set(session)
}

export const ensureNostrIdentityBrowserSession = (
  ownerPubkey: string,
  options: EnsureNostrIdentityBrowserSessionOptions = {}
): NostrIdentitySession => {
  const existing = loadNostrIdentityBrowserSession(ownerPubkey, options)
  if (existing) return existing

  const session = createLocalNostrIdentitySession({
    ...(options.profileId ? { profileId: options.profileId } : {}),
    ...(options.appKeySecretKey ? { appKeySecretKey: options.appKeySecretKey } : {}),
    ...(options.createdAt !== undefined ? { createdAt: options.createdAt } : {}),
    ...(options.clientNonce ? { clientNonce: options.clientNonce } : {}),
    label: options.label ?? 'This device',
  })
  saveNostrIdentityBrowserSession(ownerPubkey, session, options)
  return session
}

export const clearNostrIdentityBrowserSession = (
  ownerPubkey: string,
  options: NostrIdentityBrowserSessionStoreOptions = {}
): void => {
  clearNostrIdentitySession({
    storage: options.storage,
    key: nostrIdentitySessionStorageKey(ownerPubkey),
  })
  if (get(nostrIdentitySession)?.profileId) {
    nostrIdentitySession.set(null)
  }
}

export const createNostrIdentityBrowserSessionSigner = (
  session: NostrIdentitySession | null = get(nostrIdentitySession)
): NostrIdentityEventSigner => {
  if (!session) {
    throw new Error('NostrIdentity session is not available')
  }
  return createNostrIdentitySignerFromNsec(session.appKeyNsec)
}

export const publishNostrIdentityBrowserSessionRoster = (
  session: NostrIdentitySession,
  publish: NostrIdentityEventPublisher
): Promise<void> => publishNostrIdentitySessionRosterEvents(session, publish)

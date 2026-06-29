// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { get } from 'svelte/store'
import type { Event } from 'nostr-tools'
import {
  clearNostrIdentityBrowserSession,
  createNostrIdentityBrowserSessionSigner,
  ensureNostrIdentityBrowserSession,
  nostrIdentitySession,
  loadNostrIdentityBrowserSession,
  publishNostrIdentityBrowserSessionRoster,
  saveNostrIdentityBrowserSession,
} from './nostrIdentitySession'

const OWNER_PUBKEY = '989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f'
const PROFILE_ID = '123e4567-e89b-42d3-a456-426614174000'

const createStorage = () => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}

describe('nostrIdentitySession', () => {
  afterEach(() => {
    nostrIdentitySession.set(null)
  })

  it('creates, stores, restores, and signs with a shared NostrIdentity session', async () => {
    const storage = createStorage()
    const session = ensureNostrIdentityBrowserSession(OWNER_PUBKEY, {
      storage,
      profileId: PROFILE_ID,
      createdAt: 1700000300,
      clientNonce: 'iris-chat-bootstrap',
      label: 'Iris Chat Web',
    })

    expect(session.profileId).toBe(PROFILE_ID)
    expect(session.label).toBe('Iris Chat Web')
    expect(get(nostrIdentitySession)?.appKeyPubkey).toBe(session.appKeyPubkey)

    const restored = loadNostrIdentityBrowserSession(OWNER_PUBKEY, { storage })
    expect(restored?.profileId).toBe(PROFILE_ID)
    expect(restored?.appKeyPubkey).toBe(session.appKeyPubkey)

    const signer = createNostrIdentityBrowserSessionSigner(restored)
    expect(await Promise.resolve(signer.getPublicKey())).toBe(session.appKeyPubkey)
  })

  it('saves, publishes, and clears through @iris/identity helpers', async () => {
    const storage = createStorage()
    const session = ensureNostrIdentityBrowserSession(OWNER_PUBKEY, {
      storage,
      profileId: PROFILE_ID,
      createdAt: 1700000300,
      clientNonce: 'iris-chat-bootstrap',
    })
    const events: Event[] = []

    saveNostrIdentityBrowserSession(OWNER_PUBKEY, session, { storage })
    await publishNostrIdentityBrowserSessionRoster(session, (event) => {
      events.push(event)
    })

    expect(events.map((event) => event.id)).toEqual(session.rosterOps.map((op) => op.op_id))

    clearNostrIdentityBrowserSession(OWNER_PUBKEY, { storage })
    expect(loadNostrIdentityBrowserSession(OWNER_PUBKEY, { storage })).toBeNull()
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nip19 } from 'nostr-tools'
import { get } from 'svelte/store'
import { Invite } from 'nostr-double-ratchet'

const MY_PUBKEY = 'a'.repeat(64)

const mocks = vi.hoisted(() => {
  const state: { sessionManager: any | null } = { sessionManager: null }
  return {
    ensureDeviceRegistered: vi.fn(),
    getSessionManager: vi.fn(() => state.sessionManager),
    waitForSessionManager: vi.fn(() => Promise.resolve(state.sessionManager)),
    setSessionManager: (value: any | null) => {
      state.sessionManager = value
    },
  }
})

vi.mock('./identity', () => {
  const { writable } = require('svelte/store')
  return {
    ndk: writable({}),
    getPrivkeyBytes: () => null,
    getPubkey: () => MY_PUBKEY,
    hasNip44Support: () => true,
    isNip07Login: () => false,
  }
})

vi.mock('./privateChats', () => ({
  getSessionManager: () => mocks.getSessionManager(),
  waitForSessionManager: () => mocks.waitForSessionManager(),
  ensureDeviceRegistered: (...args: any[]) => mocks.ensureDeviceRegistered(...args),
}))

vi.mock('./storage', () => ({
  saveSession: vi.fn().mockResolvedValue(undefined),
  getAllSessions: vi.fn().mockResolvedValue([]),
  saveMessage: vi.fn().mockResolvedValue(undefined),
  getMessagesForSession: vi.fn().mockResolvedValue([]),
  serializeSessionState: vi.fn(),
  deserializeSessionState: vi.fn(),
  clearAllData: vi.fn(),
  deleteSession: vi.fn().mockResolvedValue(undefined),
  deleteMessagesForSession: vi.fn().mockResolvedValue(undefined),
  deleteMessage: vi.fn().mockResolvedValue(undefined),
  saveInvite: vi.fn().mockResolvedValue(undefined),
  getAllInvites: vi.fn().mockResolvedValue([]),
  updateInviteLabel: vi.fn().mockResolvedValue(undefined),
  addInviteUsedBy: vi.fn().mockResolvedValue(undefined),
  updateMessageStatus: vi.fn().mockResolvedValue(undefined),
  saveProcessedEvent: vi.fn(),
}))

vi.mock('./notifications', () => ({
  updateDMSubscription: vi.fn(),
}))

vi.mock('./groups', () => ({
  handleGroupEvent: vi.fn(),
}))

vi.mock('./typingState', () => ({
  setRemoteTyping: vi.fn(),
  clearRemoteTyping: vi.fn(),
  TYPING_EXPIRY_MS: 10000,
}))

vi.mock('./receiptSettings', () => {
  const { writable } = require('svelte/store')
  return {
    receiptSettings: writable({
      sendDeliveryReceipts: false,
      sendReadReceipts: false,
    }),
  }
})

vi.mock('./typingSettings', () => {
  const { writable } = require('svelte/store')
  return {
    typingSettings: writable({
      sendTypingIndicators: false,
    }),
  }
})

vi.mock('./receipts', () => ({
  shouldAdvanceStatus: vi.fn(() => false),
  parseReceipt: vi.fn(() => null),
}))

import { acceptInvite, parseInviteFromUrl, chats, type ChatSession } from './chat'

beforeEach(() => {
  chats.set(new Map())
  mocks.ensureDeviceRegistered.mockReset()
  mocks.ensureDeviceRegistered.mockResolvedValue(undefined)
  mocks.getSessionManager.mockClear()
  mocks.waitForSessionManager.mockClear()
  mocks.setSessionManager(null)
})

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('Invite Parsing / Acceptance', () => {
  it('parses #/npub... style invite URLs', () => {
    const pubkey = 'b'.repeat(64)
    const npub = nip19.npubEncode(pubkey)
    const url = `https://chat.iris.to/#/${npub}`

    const invite = parseInviteFromUrl(url)

    expect(invite).toEqual({ type: 'pubkey', pubkey })
  })

  it('acceptInvite(pubkey) should not block UI navigation on device registration for other users', async () => {
    const registration = defer<void>()
    mocks.ensureDeviceRegistered.mockReturnValue(registration.promise)

    const pubkey = 'c'.repeat(64)
    const invite = { type: 'pubkey', pubkey } as const

    let session: ChatSession | undefined
    try {
      session = await Promise.race([
        acceptInvite(invite),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 25)
        ),
      ])
    } finally {
      registration.resolve()
    }

    expect(session?.id).toBe(pubkey)
    expect(get(chats).has(pubkey)).toBe(true)
    expect(mocks.ensureDeviceRegistered).toHaveBeenCalledTimes(1)
  })

  it('acceptInvite(pubkey) should wait for device registration before opening self chat', async () => {
    const registration = defer<void>()
    mocks.ensureDeviceRegistered.mockReturnValue(registration.promise)

    const invite = { type: 'pubkey', pubkey: MY_PUBKEY } as const
    const acceptancePromise = acceptInvite(invite)

    let settled = false
    void acceptancePromise.then(() => {
      settled = true
    })

    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(settled).toBe(false)
    expect(get(chats).has(MY_PUBKEY)).toBe(true)
    expect(mocks.ensureDeviceRegistered).toHaveBeenCalledTimes(1)

    registration.resolve()

    const session = await acceptancePromise
    expect(session.id).toBe(MY_PUBKEY)
    expect(get(chats).has(MY_PUBKEY)).toBe(true)
  })

  it('acceptInvite(pubkey) should wait for SessionManager readiness before opening self chat', async () => {
    const sessionManagerReady = defer<void>()
    mocks.waitForSessionManager.mockReturnValue(sessionManagerReady.promise)

    const invite = { type: 'pubkey', pubkey: MY_PUBKEY } as const
    const acceptancePromise = acceptInvite(invite)

    let settled = false
    void acceptancePromise.then(() => {
      settled = true
    })

    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(settled).toBe(false)
    expect(mocks.ensureDeviceRegistered).toHaveBeenCalledTimes(1)
    expect(mocks.waitForSessionManager).toHaveBeenCalledTimes(1)

    sessionManagerReady.resolve()

    const session = await acceptancePromise
    expect(session.id).toBe(MY_PUBKEY)
    expect(get(chats).has(MY_PUBKEY)).toBe(true)
  })

  it('acceptInvite(legacy) should use SessionManager.acceptInvite and open manager chat', async () => {
    const ownerPubkey = 'd'.repeat(64)
    const devicePubkey = 'e'.repeat(64)
    const managerAccept = vi.fn().mockImplementation(async () => {
      expect(mocks.ensureDeviceRegistered).toHaveBeenCalledTimes(1)
      return { ownerPublicKey: ownerPubkey }
    })
    mocks.setSessionManager({
      getDeviceId: () => devicePubkey,
      acceptInvite: managerAccept,
    })

    const legacyInvite = Invite.createNew(devicePubkey)
    legacyInvite.ownerPubkey = ownerPubkey

    const session = await acceptInvite({ type: 'legacy', invite: legacyInvite })

    expect(session.id).toBe(ownerPubkey)
    expect(session.mode).toBe('manager')
    expect(get(chats).has(ownerPubkey)).toBe(true)
    await vi.waitFor(() => expect(managerAccept).toHaveBeenCalledTimes(1))
    expect(mocks.ensureDeviceRegistered).toHaveBeenCalledTimes(1)
  })

  it('acceptInvite(legacy) should wait for device registration before publishing owner claims', async () => {
    const ownerPubkey = 'h'.repeat(64)
    const devicePubkey = 'i'.repeat(64)
    const registration = defer<void>()

    mocks.ensureDeviceRegistered.mockReturnValue(registration.promise)

    const managerAccept = vi.fn().mockResolvedValue({ ownerPublicKey: ownerPubkey })
    mocks.setSessionManager({
      getDeviceId: () => devicePubkey,
      acceptInvite: managerAccept,
    })

    const legacyInvite = Invite.createNew(devicePubkey)
    legacyInvite.ownerPubkey = ownerPubkey

    const acceptPromise = acceptInvite({ type: 'legacy', invite: legacyInvite })

    await vi.waitFor(() => expect(mocks.ensureDeviceRegistered).toHaveBeenCalledTimes(1))
    expect(managerAccept).not.toHaveBeenCalled()

    registration.resolve()
    const session = await acceptPromise

    expect(session?.id).toBe(ownerPubkey)
    expect(get(chats).has(ownerPubkey)).toBe(true)
    expect(mocks.ensureDeviceRegistered).toHaveBeenCalledTimes(1)
    expect(managerAccept).toHaveBeenCalledTimes(1)
  })

  it('acceptInvite(legacy) should surface handshake errors', async () => {
    const ownerPubkey = 'f'.repeat(64)
    const devicePubkey = 'g'.repeat(64)
    const managerAccept = vi.fn().mockRejectedValue(new Error('Extension does not support NIP-44'))
    mocks.setSessionManager({
      getDeviceId: () => devicePubkey,
      acceptInvite: managerAccept,
    })

    const legacyInvite = Invite.createNew(devicePubkey)
    legacyInvite.ownerPubkey = ownerPubkey

    await expect(acceptInvite({ type: 'legacy', invite: legacyInvite })).rejects.toThrow(
      'NIP-44'
    )
    expect(get(chats).has(ownerPubkey)).toBe(false)
    expect(mocks.ensureDeviceRegistered).toHaveBeenCalledTimes(1)
    expect(managerAccept).toHaveBeenCalledTimes(1)
  })
})

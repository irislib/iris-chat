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
    waitForSendReadySessionManager: vi.fn(() => Promise.resolve(state.sessionManager)),
    waitForPeerSendReadySessionManager: vi.fn(() => Promise.resolve(state.sessionManager)),
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
  waitForSendReadySessionManager: () => mocks.waitForSendReadySessionManager(),
  waitForPeerSendReadySessionManager: (...args: any[]) =>
    mocks.waitForPeerSendReadySessionManager(...args),
  waitForNdrRuntime: async () => {
    await mocks.waitForSessionManager()
    return {
      setupUser: (...args: any[]) => mocks.getSessionManager()?.setupUser?.(...args),
      acceptInvite: (...args: any[]) => mocks.getSessionManager()?.acceptInvite?.(...args),
      getDelegateManager: () => mocks.getSessionManager()?.getDelegateManager?.(),
    }
  },
  waitForSendReadyRuntime: async () => {
    await mocks.waitForSendReadySessionManager()
    return {
      setupUser: (...args: any[]) => mocks.getSessionManager()?.setupUser?.(...args),
      acceptInvite: (...args: any[]) => mocks.getSessionManager()?.acceptInvite?.(...args),
    }
  },
  preparePeerNdrRuntime: async (...args: any[]) => {
    await mocks.waitForPeerSendReadySessionManager(...args)
    return {
      setupUser: (...setupArgs: any[]) => mocks.getSessionManager()?.setupUser?.(...setupArgs),
    }
  },
  ensureDeviceRegistered: (...args: any[]) => mocks.ensureDeviceRegistered(...args),
  getNdrRuntime: () => ({
    setupUser: (...args: any[]) => mocks.getSessionManager()?.setupUser?.(...args),
    acceptInvite: (...args: any[]) => mocks.getSessionManager()?.acceptInvite?.(...args),
    getState: () => ({
      currentDevicePubkey: mocks.getSessionManager()?.getDeviceId?.() || MY_PUBKEY,
      sessionManagerReady: Boolean(mocks.getSessionManager()),
    }),
    getSessionUserRecords: () => mocks.getSessionManager()?.getUserRecords?.() || new Map(),
    onGroupEvent: () => () => {},
  }),
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
  updateMessageRecipientStatuses: vi.fn().mockResolvedValue(undefined),
  updateMessageDeliveryTrace: vi.fn().mockResolvedValue(undefined),
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

import { acceptInvite, createAndSaveInvite, getInviteUrl, parseInviteFromUrl, chats, type ChatSession } from './chat'
import { saveInvite } from './storage'

beforeEach(() => {
  chats.set(new Map())
  mocks.ensureDeviceRegistered.mockReset()
  mocks.ensureDeviceRegistered.mockResolvedValue(undefined)
  mocks.getSessionManager.mockClear()
  mocks.waitForSessionManager.mockClear()
  mocks.waitForSendReadySessionManager.mockClear()
  mocks.waitForPeerSendReadySessionManager.mockClear()
  const delegateInvite = Invite.createNew('d'.repeat(64))
  const sessionManager = {
    setupUser: vi.fn().mockResolvedValue(undefined),
    getDelegateManager: () => ({
      getInvite: () => delegateInvite,
    }),
  }
  mocks.setSessionManager(sessionManager)
  mocks.waitForSendReadySessionManager.mockResolvedValue(sessionManager)
  mocks.waitForPeerSendReadySessionManager.mockResolvedValue(sessionManager)
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
  it('createAndSaveInvite stores the delegate invite without waiting for relay registration', async () => {
    const registration = defer<void>()
    mocks.ensureDeviceRegistered.mockReturnValue(registration.promise)

    const invite = await Promise.race([
      createAndSaveInvite('Test invite'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 25)
      ),
    ])

    expect(invite.label).toBe('Test invite')
    expect(invite.invite.type).toBe('legacy')
    if (invite.invite.type === 'legacy') {
      expect(invite.invite.invite.ownerPubkey).toBe(MY_PUBKEY)
    }
    expect(mocks.ensureDeviceRegistered).toHaveBeenCalledTimes(1)
    expect(saveInvite).toHaveBeenCalledTimes(1)

    registration.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('parses #/npub... style invite URLs', () => {
    const pubkey = 'b'.repeat(64)
    const npub = nip19.npubEncode(pubkey)
    const url = `https://chat.iris.to/#/${npub}`

    const invite = parseInviteFromUrl(url)

    expect(invite).toEqual({ type: 'pubkey', pubkey })
  })

  it('generates #/npub... style profile links', () => {
    const pubkey = 'b'.repeat(64)
    const npub = nip19.npubEncode(pubkey)

    const url = getInviteUrl({ type: 'pubkey', pubkey })

    expect(url).toBe(`https://chat.iris.to/#/${npub}`)
  })

  it('generates and parses #/invite... style legacy links', () => {
    const ownerPubkey = 'd'.repeat(64)
    const devicePubkey = 'e'.repeat(64)
    const legacyInvite = Invite.createNew(devicePubkey)
    legacyInvite.ownerPubkey = ownerPubkey

    const url = getInviteUrl({ type: 'legacy', invite: legacyInvite })
    const parsed = parseInviteFromUrl(url)

    expect(url).toMatch(/^https:\/\/chat\.iris\.to\/#\/invite\//)
    expect(parsed?.type).toBe('legacy')
    if (parsed?.type === 'legacy') {
      expect(parsed.invite.ownerPubkey).toBe(ownerPubkey)
    }
  })

  it('acceptInvite(pubkey) should open immediately while bootstrapping device registration in the background', async () => {
    const pubkey = 'c'.repeat(64)
    const invite = { type: 'pubkey', pubkey } as const
    const registration = defer<void>()

    mocks.waitForSendReadySessionManager.mockReturnValue(registration.promise)

    const session = await Promise.race([
      acceptInvite(invite),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 25)
      ),
    ])

    expect(session?.id).toBe(pubkey)
    expect(get(chats).has(pubkey)).toBe(true)
    expect(mocks.waitForSendReadySessionManager).toHaveBeenCalledTimes(1)
    expect(mocks.ensureDeviceRegistered).not.toHaveBeenCalled()

    registration.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('acceptInvite(pubkey) should open self chat without device registration', async () => {
    const invite = { type: 'pubkey', pubkey: MY_PUBKEY } as const

    const session = await Promise.race([
      acceptInvite(invite),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 25)
      ),
    ])

    expect(session.id).toBe(MY_PUBKEY)
    expect(get(chats).has(MY_PUBKEY)).toBe(true)
    expect(mocks.ensureDeviceRegistered).not.toHaveBeenCalled()
  })

  it('acceptInvite(pubkey) should wait for SessionManager readiness before opening self chat', async () => {
    const setupUser = vi.fn().mockResolvedValue(undefined)
    const sessionManager = { setupUser }
    const sessionManagerReady = defer<typeof sessionManager>()
    mocks.setSessionManager(sessionManager)
    mocks.waitForSessionManager.mockReturnValue(sessionManagerReady.promise)

    const invite = { type: 'pubkey', pubkey: MY_PUBKEY } as const
    const acceptancePromise = acceptInvite(invite)

    let settled = false
    void acceptancePromise.then(() => {
      settled = true
    })

    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(settled).toBe(false)
    expect(mocks.ensureDeviceRegistered).not.toHaveBeenCalled()
    expect(mocks.waitForSessionManager).toHaveBeenCalledTimes(1)

    sessionManagerReady.resolve(sessionManager)

    const session = await acceptancePromise
    expect(session.id).toBe(MY_PUBKEY)
    expect(get(chats).has(MY_PUBKEY)).toBe(true)
    expect(setupUser).toHaveBeenCalledWith(MY_PUBKEY)
  })

  it('acceptInvite(legacy) should use SessionManager.acceptInvite and open manager chat', async () => {
    const ownerPubkey = 'd'.repeat(64)
    const devicePubkey = 'e'.repeat(64)
    const managerAccept = vi.fn().mockResolvedValue({ ownerPublicKey: ownerPubkey })
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
    expect(mocks.ensureDeviceRegistered).toHaveBeenCalled()
    await vi.waitFor(() => expect(managerAccept).toHaveBeenCalledTimes(1))
  })

  it('acceptInvite(legacy) should open without waiting for relay registration', async () => {
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

    const session = await Promise.race([
      acceptInvite({ type: 'legacy', invite: legacyInvite }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 25)
      ),
    ])

    expect(mocks.ensureDeviceRegistered).toHaveBeenCalledTimes(1)
    expect(session.id).toBe(ownerPubkey)
    expect(get(chats).has(ownerPubkey)).toBe(true)
    expect(managerAccept).toHaveBeenCalledTimes(1)

    registration.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
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
    expect(mocks.ensureDeviceRegistered).toHaveBeenCalled()
    expect(managerAccept).toHaveBeenCalledTimes(1)
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nip19 } from 'nostr-tools'
import { get } from 'svelte/store'

const MY_PUBKEY = 'a'.repeat(64)

const mocks = vi.hoisted(() => {
  return {
    ensureDeviceRegistered: vi.fn(),
  }
})

vi.mock('./identity', () => {
  const { writable } = require('svelte/store')
  return {
    ndk: writable({}),
    getPrivkeyBytes: () => null,
    getPubkey: () => MY_PUBKEY,
    isNip07Login: () => false,
  }
})

vi.mock('./privateChats', () => ({
  getSessionManager: () => null,
  waitForSessionManager: () => Promise.resolve(null),
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

  it('acceptInvite(pubkey) should not block UI navigation on device registration', async () => {
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
})


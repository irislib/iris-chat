import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { CHAT_MESSAGE_KIND, RECEIPT_KIND } from 'nostr-double-ratchet'

const MY_PUBKEY = 'a'.repeat(64)
const THEIR_PUBKEY = 'b'.repeat(64)

const mocks = vi.hoisted(() => {
  const statusRank: Record<string, number> = {
    delivered: 1,
    seen: 2,
  }
  const state: { userRecords: Map<string, any> } = {
    userRecords: new Map(),
  }

  return {
    parseReceipt: vi.fn((rumor: { kind?: number; content?: string; tags?: string[][] }) => {
      if (rumor.kind !== 15) return null
      if (rumor.content !== 'delivered' && rumor.content !== 'seen') return null
      const messageIds = (rumor.tags || [])
        .filter((tag) => tag[0] === 'e' && !!tag[1])
        .map((tag) => tag[1])
      return { type: rumor.content, messageIds }
    }),
    shouldAdvanceStatus: vi.fn((current: string | undefined, next: string) => {
      const currentRank = current ? (statusRank[current] || 0) : 0
      const nextRank = statusRank[next] || 0
      return nextRank > currentRank
    }),
    updateMessageStatus: vi.fn().mockResolvedValue(undefined),
    updateMessageRecipientStatuses: vi.fn().mockResolvedValue(undefined),
    updateMessageDeliveryTrace: vi.fn().mockResolvedValue(undefined),
    ensureDeviceRegistered: vi.fn().mockResolvedValue(undefined),
    runtimeSendEvent: vi.fn().mockResolvedValue(undefined),
    waitForPeerSendReadySessionManager: vi
      .fn()
      .mockRejectedValue(new Error('manager unavailable in test')),
    getUserRecords: () => state.userRecords,
    setUserRecords: (value: Map<string, any>) => {
      state.userRecords = value
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
  updateMessageStatus: (...args: [string, 'delivered' | 'seen']) => mocks.updateMessageStatus(...args),
  updateMessageRecipientStatuses: (...args: [string, Record<string, 'sent' | 'delivered' | 'seen'>]) =>
    mocks.updateMessageRecipientStatuses(...args),
  updateMessageDeliveryTrace: (...args: [string, unknown]) => mocks.updateMessageDeliveryTrace(...args),
  saveProcessedEvent: vi.fn(),
}))

vi.mock('./privateChats', () => ({
  getSessionManager: () => null,
  waitForSessionManager: () => Promise.reject(new Error('manager unavailable in test')),
  ensureDeviceRegistered: (...args: []) => mocks.ensureDeviceRegistered(...args),
  waitForPeerSendReadySessionManager: (...args: [string]) =>
    mocks.waitForPeerSendReadySessionManager(...args),
  preparePeerNdrRuntime: (...args: [string]) =>
    mocks.waitForPeerSendReadySessionManager(...args),
  waitForNdrRuntime: async () => ({
    sendEvent: (...args: [string, unknown]) => mocks.runtimeSendEvent(...args),
  }),
  getNdrRuntime: () => ({
    sendEvent: (...args: [string, unknown]) => mocks.runtimeSendEvent(...args),
    sendReceipt: vi.fn().mockResolvedValue(undefined),
    getState: () => ({ currentDevicePubkey: MY_PUBKEY, sessionManagerReady: true }),
    getSessionUserRecords: () => mocks.getUserRecords(),
    onGroupEvent: () => () => {},
  }),
  republishInvite: vi.fn().mockResolvedValue(undefined),
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
  parseReceipt: (...args: [{ kind?: number; content?: string; tags?: string[][] }]) =>
    mocks.parseReceipt(...args),
  shouldAdvanceStatus: (...args: [string | undefined, string]) =>
    mocks.shouldAdvanceStatus(...args),
}))

import { chats, currentChat, handleManagerEvent, invites, type ChatSession } from './chat'
import { devices } from './devices'
import { following } from './following'
import { messageRequests } from './messageRequests'
import { messageRequestSettings } from './messageRequestSettings'
import { getMessageRequestPolicyContext, isMessageRequestChat } from './messageRequestPolicy'
import { receiptSettings } from './receiptSettings'

beforeEach(() => {
  chats.set(new Map())
  currentChat.set(null)
  invites.set(new Map())
  devices.reset()
  following.set(new Set())
  messageRequests.set({ acceptedChats: {}, rejectedChats: {} })
  messageRequestSettings.set({ receiveMessageRequests: true })
  receiptSettings.set({
    sendDeliveryReceipts: false,
    sendReadReceipts: false,
  })
  mocks.parseReceipt.mockClear()
  mocks.shouldAdvanceStatus.mockClear()
  mocks.updateMessageStatus.mockClear()
  mocks.updateMessageRecipientStatuses.mockClear()
  mocks.updateMessageDeliveryTrace.mockClear()
  mocks.ensureDeviceRegistered.mockClear()
  mocks.ensureDeviceRegistered.mockResolvedValue(undefined)
  mocks.runtimeSendEvent.mockClear()
  mocks.runtimeSendEvent.mockResolvedValue(undefined)
  mocks.waitForPeerSendReadySessionManager.mockClear()
  mocks.setUserRecords(new Map())
})

describe('manager receipts', () => {
  it('marks incoming messages as seen when seen receipt arrives from another own session', async () => {
    const now = Date.now()
    const createdAt = Math.floor(now / 1000)

    await handleManagerEvent(
      {
        id: 'in-1',
        kind: CHAT_MESSAGE_KIND,
        pubkey: THEIR_PUBKEY,
        content: 'hello',
        created_at: createdAt,
        tags: [['p', MY_PUBKEY], ['ms', String(now)]],
      } as never,
      THEIR_PUBKEY
    )

    let chat = get(chats).get(THEIR_PUBKEY)
    expect(chat?.messages).toHaveLength(1)
    expect(chat?.messages[0]).toMatchObject({ id: 'in-1', isMine: false })
    expect(chat?.messages[0]?.status).not.toBe('seen')

    await handleManagerEvent(
      {
        id: 'rcpt-1',
        kind: RECEIPT_KIND,
        pubkey: MY_PUBKEY,
        content: 'seen',
        created_at: createdAt + 1,
        tags: [['p', THEIR_PUBKEY], ['e', 'in-1'], ['ms', String(now + 1000)]],
      } as never,
      MY_PUBKEY
    )

    chat = get(chats).get(THEIR_PUBKEY)
    expect(chat?.messages[0]?.status).toBe('seen')
    expect(mocks.updateMessageStatus).toHaveBeenCalledWith('in-1', 'seen')
  })

  it('treats sender-copy receipts from another client as self receipts', async () => {
    const now = Date.now()
    const createdAt = Math.floor(now / 1000)
    const OTHER_CLIENT_PUBKEY = 'c'.repeat(64)

    await handleManagerEvent(
      {
        id: 'in-2',
        kind: CHAT_MESSAGE_KIND,
        pubkey: THEIR_PUBKEY,
        content: 'hello',
        created_at: createdAt,
        tags: [['p', MY_PUBKEY], ['ms', String(now)]],
      } as never,
      THEIR_PUBKEY
    )

    await handleManagerEvent(
      {
        id: 'rcpt-3',
        kind: RECEIPT_KIND,
        pubkey: OTHER_CLIENT_PUBKEY,
        content: 'seen',
        created_at: createdAt + 1,
        tags: [['p', THEIR_PUBKEY], ['e', 'in-2'], ['ms', String(now + 1000)]],
      } as never,
      THEIR_PUBKEY
    )

    const chat = get(chats).get(THEIR_PUBKEY)
    expect(chat?.messages[0]).toMatchObject({
      id: 'in-2',
      isMine: false,
      status: 'seen',
    })
    expect(mocks.updateMessageStatus).toHaveBeenCalledWith('in-2', 'seen')
  })

  it('keeps updating own outgoing messages when seen receipts arrive from peer', async () => {
    const now = Date.now()
    const createdAt = Math.floor(now / 1000)

    await handleManagerEvent(
      {
        id: 'out-1',
        kind: CHAT_MESSAGE_KIND,
        pubkey: MY_PUBKEY,
        content: 'hello peer',
        created_at: createdAt,
        tags: [['p', THEIR_PUBKEY], ['ms', String(now)]],
      } as never,
      MY_PUBKEY
    )

    await handleManagerEvent(
      {
        id: 'rcpt-2',
        kind: RECEIPT_KIND,
        pubkey: THEIR_PUBKEY,
        content: 'seen',
        created_at: createdAt + 1,
        tags: [['p', MY_PUBKEY], ['e', 'out-1'], ['ms', String(now + 1000)]],
      } as never,
      THEIR_PUBKEY
    )

    const chat = get(chats).get(THEIR_PUBKEY)
    expect(chat?.messages[0]).toMatchObject({
      id: 'out-1',
      isMine: true,
      status: 'seen',
      recipientStatuses: {
        [THEIR_PUBKEY]: 'seen',
      },
    })
    expect(mocks.updateMessageStatus).toHaveBeenCalledWith('out-1', 'seen')
    expect(mocks.updateMessageRecipientStatuses).toHaveBeenCalledWith('out-1', {
      [THEIR_PUBKEY]: 'seen',
    })
  })

  it('keeps preexisting empty manager chats from unknown senders in requests', async () => {
    receiptSettings.set({
      sendDeliveryReceipts: true,
      sendReadReceipts: false,
    })

    const existingChat: ChatSession = {
      id: THEIR_PUBKEY,
      recipientPubkey: THEIR_PUBKEY,
      mode: 'manager',
      messages: [],
    }
    chats.set(new Map([[THEIR_PUBKEY, existingChat]]))

    const now = Date.now()
    const createdAt = Math.floor(now / 1000)

    await handleManagerEvent(
      {
        id: 'msg-request-1',
        kind: CHAT_MESSAGE_KIND,
        pubkey: THEIR_PUBKEY,
        content: 'hello from unknown sender',
        created_at: createdAt,
        tags: [['p', MY_PUBKEY], ['ms', String(now)]],
      } as never,
      THEIR_PUBKEY
    )

    const chat = get(chats).get(THEIR_PUBKEY)
    expect(chat?.messages).toHaveLength(1)
    expect(chat?.messages[0]).toMatchObject({
      id: 'msg-request-1',
      isMine: false,
    })
    expect(chat?.messages[0]?.status).toBeUndefined()
    expect(isMessageRequestChat(chat!, getMessageRequestPolicyContext())).toBe(true)
    expect(mocks.waitForPeerSendReadySessionManager).not.toHaveBeenCalled()
  })

  it('accepts the first inbound message when it arrives through a local invite session', async () => {
    receiptSettings.set({
      sendDeliveryReceipts: true,
      sendReadReceipts: false,
    })

    const inviteEphemeralPubkey = 'c'.repeat(64)
    invites.set(new Map([
      [
        'invite-1',
        {
          id: 'invite-1',
          invite: {
            type: 'legacy',
            invite: { inviterEphemeralPublicKey: inviteEphemeralPubkey },
          },
          createdAt: Date.now(),
          usedBy: [],
          unsubscribe: () => {},
        } as never,
      ],
    ]))
    mocks.setUserRecords(new Map([
      [
        THEIR_PUBKEY,
        {
          devices: new Map([
            [
              'peer-device',
              {
                activeSession: {
                  state: {
                    ourCurrentNostrKey: { publicKey: inviteEphemeralPubkey },
                  },
                },
                inactiveSessions: [],
              },
            ],
          ]),
        },
      ],
    ]))

    const now = Date.now()
    const createdAt = Math.floor(now / 1000)

    await handleManagerEvent(
      {
        id: 'invite-msg-1',
        kind: CHAT_MESSAGE_KIND,
        pubkey: THEIR_PUBKEY,
        content: 'hello through invite',
        created_at: createdAt,
        tags: [['p', MY_PUBKEY], ['ms', String(now)]],
      } as never,
      THEIR_PUBKEY
    )

    const chat = get(chats).get(THEIR_PUBKEY)
    const decisions = get(messageRequests)
    expect(chat?.messages).toHaveLength(1)
    expect(chat?.messages[0]).toMatchObject({
      id: 'invite-msg-1',
      isMine: false,
      status: 'delivered',
    })
    expect(decisions.acceptedChats[THEIR_PUBKEY]).toBe(true)
    expect(isMessageRequestChat(chat!, getMessageRequestPolicyContext())).toBe(false)
  })
})

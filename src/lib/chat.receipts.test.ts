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
    waitForPeerSendReadySessionManager: vi
      .fn()
      .mockRejectedValue(new Error('manager unavailable in test')),
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
  saveProcessedEvent: vi.fn(),
}))

vi.mock('./privateChats', () => ({
  getSessionManager: () => null,
  waitForSessionManager: () => Promise.reject(new Error('manager unavailable in test')),
  ensureDeviceRegistered: vi.fn(),
  waitForPeerSendReadySessionManager: (...args: [string]) =>
    mocks.waitForPeerSendReadySessionManager(...args),
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

import { chats, currentChat, handleManagerEvent, type ChatSession } from './chat'
import { devices } from './devices'
import { following } from './following'
import { messageRequests } from './messageRequests'
import { messageRequestSettings } from './messageRequestSettings'
import { getMessageRequestPolicyContext, isMessageRequestChat } from './messageRequestPolicy'
import { receiptSettings } from './receiptSettings'

beforeEach(() => {
  chats.set(new Map())
  currentChat.set(null)
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
  mocks.waitForPeerSendReadySessionManager.mockClear()
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
    })
    expect(mocks.updateMessageStatus).toHaveBeenCalledWith('out-1', 'seen')
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
})

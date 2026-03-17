import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

const MY_PUBKEY = 'a'.repeat(64)
const PEER_PUBKEY = 'b'.repeat(64)

const mocks = vi.hoisted(() => {
  const state: { sessionManager: any | null } = { sessionManager: null }

  return {
    getSessionManager: vi.fn(() => state.sessionManager),
    setSessionManager: (value: any | null) => {
      state.sessionManager = value
    },
    deleteSession: vi.fn().mockResolvedValue(undefined),
    deleteMessagesForSession: vi.fn().mockResolvedValue(undefined),
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
  deleteSession: (...args: [string]) => mocks.deleteSession(...args),
  deleteMessagesForSession: (...args: [string]) => mocks.deleteMessagesForSession(...args),
  deleteMessage: vi.fn().mockResolvedValue(undefined),
  saveInvite: vi.fn().mockResolvedValue(undefined),
  getAllInvites: vi.fn().mockResolvedValue([]),
  updateInviteLabel: vi.fn().mockResolvedValue(undefined),
  addInviteUsedBy: vi.fn().mockResolvedValue(undefined),
  updateMessageStatus: vi.fn().mockResolvedValue(undefined),
  saveProcessedEvent: vi.fn(),
}))

vi.mock('./privateChats', () => ({
  getSessionManager: () => mocks.getSessionManager(),
  waitForSessionManager: () => Promise.reject(new Error('manager unavailable in test')),
  ensureDeviceRegistered: vi.fn(),
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
  shouldAdvanceStatus: vi.fn(() => false),
  parseReceipt: vi.fn(() => null),
}))

import { chats, currentChat, deleteChat, type ChatSession } from './chat'

beforeEach(() => {
  chats.set(new Map())
  currentChat.set(null)
  mocks.deleteSession.mockClear()
  mocks.deleteMessagesForSession.mockClear()
  mocks.getSessionManager.mockClear()
  mocks.setSessionManager(null)
})

describe('deleteChat', () => {
  it('uses SessionManager chat-deletion API and removes local chat data', async () => {
    const managerDeleteChat = vi.fn().mockResolvedValue(undefined)
    const managerDeleteUser = vi.fn().mockResolvedValue(undefined)
    mocks.setSessionManager({
      deleteChat: managerDeleteChat,
      deleteUser: managerDeleteUser,
    })

    const chatSession: ChatSession = {
      id: PEER_PUBKEY,
      recipientPubkey: PEER_PUBKEY,
      mode: 'manager',
      messages: [],
    }

    chats.set(new Map([[chatSession.id, chatSession]]))
    currentChat.set(chatSession)

    deleteChat(chatSession)

    await Promise.resolve()

    expect(managerDeleteChat).toHaveBeenCalledWith(PEER_PUBKEY)
    expect(managerDeleteUser).not.toHaveBeenCalled()
    expect(get(chats).has(chatSession.id)).toBe(false)
    expect(get(currentChat)).toBeNull()
    expect(mocks.deleteSession).toHaveBeenCalledWith(chatSession.id)
    expect(mocks.deleteMessagesForSession).toHaveBeenCalledWith(chatSession.id)
  })
})

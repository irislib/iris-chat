vi.mock('./deviceSyncRecordApply', async importOriginal => ({
  ...await importOriginal<typeof import('./deviceSyncRecordApply')>(),
  persistMessageWithReactions: async (_owner: string, message: import('./storage').StoredMessage) => { await saveMessage(message); return message },
}))
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { saveMessage } from './storage'
import type { CallHistory } from './callHistory'

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
    nostrClient: writable({}),
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
  updateMessageRecipientStatuses: vi.fn().mockResolvedValue(undefined),
  updateMessageDeliveryTrace: vi.fn().mockResolvedValue(undefined),
  saveProcessedEvent: vi.fn(),
}))

vi.mock('./privateChats', () => ({
  getSessionManager: () => mocks.getSessionManager(),
  waitForSessionManager: () => Promise.reject(new Error('manager unavailable in test')),
  ensureDeviceRegistered: vi.fn(),
  getNdrRuntime: () => ({
    deleteChat: (...args: [string]) => mocks.getSessionManager()?.deleteChat?.(...args),
    getState: () => ({ currentDevicePubkey: MY_PUBKEY, sessionManagerReady: true }),
    getSessionUserRecords: () => new Map(),
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
  shouldAdvanceStatus: vi.fn(() => false),
  parseReceipt: vi.fn(() => null),
}))

import { chats, currentChat, deleteChat, recordCallHistory, type ChatSession } from './chat'

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


describe('local call records', () => {
  const call: CallHistory = { callId: 'ab'.repeat(16), direction: 'incoming', outcome: 'missed',
    video: true, startedAt: 1000, endedAt: 1000, durationSeconds: 0, inProgress: true }
  it('updates one durable chronological entry across ringing, answer and end', async () => {
    const chat: ChatSession = { id: PEER_PUBKEY, recipientPubkey: PEER_PUBKEY, mode: 'manager', messages: [
      { id: 'before', content: 'hello', timestamp: 500, isMine: false },
      { id: 'after', content: 'later', timestamp: 2000, isMine: true },
    ] }
    chats.set(new Map([[chat.id, chat]])); currentChat.set(chat)
    recordCallHistory(PEER_PUBKEY, call)
    const answered = { ...call, video: false, outcome: 'answered' as const, answeredAt: 4000, endedAt: 9000, durationSeconds: 5, inProgress: undefined }
    recordCallHistory(PEER_PUBKEY, answered)
    recordCallHistory(PEER_PUBKEY, answered)
    recordCallHistory(PEER_PUBKEY, call) // A delayed ringing update cannot overwrite a result.
    const messages = get(currentChat)!.messages
    expect(messages.map(m => m.id)).toEqual(['before', `call:${call.callId}`, 'after'])
    expect(messages[1]).toMatchObject({ call: answered, content: 'Incoming voice call', isMine: false })
    expect(saveMessage).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: PEER_PUBKEY, call: answered }))
  })
  it('does not create a chat for a call from an unknown person', () => {
    recordCallHistory(PEER_PUBKEY, call)
    expect(get(chats).size).toBe(0)
  })
})

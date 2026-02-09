import {describe, it, expect, vi, beforeEach} from 'vitest'
import {get} from 'svelte/store'
import {CHAT_MESSAGE_KIND} from 'nostr-double-ratchet'

const MY_PUBKEY = 'a'.repeat(64)

vi.mock('./identity', () => {
  const {writable} = require('svelte/store')
  return {
    ndk: writable({}),
    getPrivkeyBytes: () => null,
    getPubkey: () => MY_PUBKEY,
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
  const {writable} = require('svelte/store')
  return {
    receiptSettings: writable({
      sendDeliveryReceipts: false,
      sendReadReceipts: false,
    }),
  }
})

vi.mock('./typingSettings', () => {
  const {writable} = require('svelte/store')
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

import {handleManagerEvent, chats} from './chat'
import {devices} from './devices'

beforeEach(() => {
  chats.set(new Map())
  devices.reset()
})

describe('handleManagerEvent', () => {
  it('stores self manager messages (p-tag points to self)', async () => {
    const rumor = {
      id: 'msg-1',
      pubkey: MY_PUBKEY,
      content: 'hello self',
      kind: CHAT_MESSAGE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', MY_PUBKEY], ['ms', String(Date.now())]],
    }

    await handleManagerEvent(rumor as never, MY_PUBKEY)

    const chatMap = get(chats)
    const selfChat = chatMap.get(MY_PUBKEY)

    expect(selfChat).toBeTruthy()
    expect(selfChat?.messages).toHaveLength(1)
    expect(selfChat?.messages[0].content).toBe('hello self')
  })

  it('routes own-device manager messages to self chat', async () => {
    devices.setIdentityPubkey('d'.repeat(64))
    devices.setRegisteredDevices([
      { identityPubkey: 'b'.repeat(64), createdAt: Math.floor(Date.now() / 1000) },
    ])

    const rumor = {
      id: 'msg-2',
      pubkey: 'b'.repeat(64),
      content: 'hello from device',
      kind: CHAT_MESSAGE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', MY_PUBKEY], ['ms', String(Date.now())]],
    }

    await handleManagerEvent(rumor as never, 'b'.repeat(64))

    const chatMap = get(chats)
    const selfChat = chatMap.get(MY_PUBKEY)

    expect(selfChat).toBeTruthy()
    expect(selfChat?.messages).toHaveLength(1)
    expect(selfChat?.messages[0].content).toBe('hello from device')
  })
})

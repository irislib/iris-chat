import {describe, it, expect, vi, beforeEach} from 'vitest'
import {get} from 'svelte/store'
import { CHAT_MESSAGE_KIND, TYPING_KIND } from 'nostr-double-ratchet'

const MY_PUBKEY = 'a'.repeat(64)

vi.mock('./identity', () => {
  const {writable} = require('svelte/store')
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
  updateMessageStatus: vi.fn().mockResolvedValue(undefined),
  saveProcessedEvent: vi.fn(),
}))

vi.mock('./notifications', () => ({
  updateDMSubscription: vi.fn(),
}))

vi.mock('./privateChats', () => ({
  getSessionManager: () => null,
  waitForSessionManager: () => Promise.reject(new Error('manager unavailable in test')),
  ensureDeviceRegistered: vi.fn(),
  rotateDeviceInvite: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./groups', () => ({
  handleGroupEvent: vi.fn(),
}))

const typingMocks = vi.hoisted(() => ({
  setRemoteTyping: vi.fn(),
  clearRemoteTyping: vi.fn(),
}))

vi.mock('./typingState', () => ({
  setRemoteTyping: (...args: [string, number?]) => typingMocks.setRemoteTyping(...args),
  clearRemoteTyping: (...args: [string, number?]) => typingMocks.clearRemoteTyping(...args),
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
  typingMocks.setRemoteTyping.mockClear()
  typingMocks.clearRemoteTyping.mockClear()
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

  it('marks sender-copy messages from another client as mine in peer chat', async () => {
    const PEER_PUBKEY = 'c'.repeat(64)
    const OTHER_CLIENT_PUBKEY = 'd'.repeat(64)

    const rumor = {
      id: 'msg-3',
      pubkey: OTHER_CLIENT_PUBKEY,
      content: 'hello from another client',
      kind: CHAT_MESSAGE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', PEER_PUBKEY], ['ms', String(Date.now())]],
    }

    // SessionManager can surface sender-copies under the peer record even when
    // the inner rumor pubkey isn't known as one of our registered device keys.
    await handleManagerEvent(rumor as never, PEER_PUBKEY)

    const chatMap = get(chats)
    const peerChat = chatMap.get(PEER_PUBKEY)

    expect(peerChat).toBeTruthy()
    expect(peerChat?.messages).toHaveLength(1)
    expect(peerChat?.messages[0].content).toBe('hello from another client')
    expect(peerChat?.messages[0].isMine).toBe(true)
  })

  it('does not clear remote typing when processing own outgoing message copies', async () => {
    const PEER_PUBKEY = 'c'.repeat(64)

    const rumor = {
      id: 'msg-self-typing-1',
      pubkey: MY_PUBKEY,
      content: 'my own message',
      kind: CHAT_MESSAGE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', PEER_PUBKEY], ['ms', String(Date.now())]],
    }

    await handleManagerEvent(rumor as never, MY_PUBKEY)

    expect(typingMocks.clearRemoteTyping).not.toHaveBeenCalled()
  })

  it('accepts typing events despite local clock skew', async () => {
    const PEER_PUBKEY = 'c'.repeat(64)
    const rumor = {
      id: 'typing-skew-1',
      pubkey: PEER_PUBKEY,
      content: 'typing',
      kind: TYPING_KIND,
      created_at: Math.floor(Date.now() / 1000) - 120,
      tags: [['p', MY_PUBKEY], ['ms', String(Date.now() - 120000)]],
    }

    await handleManagerEvent(rumor as never, PEER_PUBKEY)

    expect(typingMocks.setRemoteTyping).toHaveBeenCalledWith(
      PEER_PUBKEY,
      rumor.created_at
    )
  })

  it('clears typing indicator when receiving typing turn-off rumor', async () => {
    const PEER_PUBKEY = 'c'.repeat(64)
    const rumor = {
      id: 'typing-stop-1',
      pubkey: PEER_PUBKEY,
      content: 'typing',
      kind: TYPING_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', MY_PUBKEY], ['expiration', '1'], ['ms', String(Date.now())]],
    }

    await handleManagerEvent(rumor as never, PEER_PUBKEY)

    expect(typingMocks.setRemoteTyping).not.toHaveBeenCalled()
    expect(typingMocks.clearRemoteTyping).toHaveBeenCalledWith(PEER_PUBKEY)
  })
})

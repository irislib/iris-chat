import {describe, it, expect, vi, beforeEach} from 'vitest'
import {get} from 'svelte/store'
import { CHAT_MESSAGE_KIND, TYPING_KIND } from 'nostr-double-ratchet'

const MY_PUBKEY = 'a'.repeat(64)
const sessionState = vi.hoisted(() => ({
  manager: null as any,
}))

const privateChatsMocks = vi.hoisted(() => ({
  ensureDeviceRegistered: vi.fn().mockResolvedValue(undefined),
  waitForSessionManager: vi.fn(() => Promise.reject(new Error('manager unavailable in test'))),
}))

const runtimeMocks = vi.hoisted(() => ({
  sendEvent: vi.fn().mockResolvedValue(undefined),
  sendReceipt: vi.fn().mockResolvedValue(undefined),
  sendTyping: vi.fn().mockResolvedValue(undefined),
}))

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
  updateMessageRecipientStatuses: vi.fn().mockResolvedValue(undefined),
  updateMessageDeliveryTrace: vi.fn().mockResolvedValue(undefined),
  saveProcessedEvent: vi.fn(),
}))

vi.mock('./notifications', () => ({
  updateDMSubscription: vi.fn(),
}))

vi.mock('./privateChats', () => ({
  getSessionManager: () => sessionState.manager,
  waitForSessionManager: privateChatsMocks.waitForSessionManager,
  ensureDeviceRegistered: privateChatsMocks.ensureDeviceRegistered,
  getNdrRuntime: () => ({
    sendEvent: runtimeMocks.sendEvent,
    sendReceipt: runtimeMocks.sendReceipt,
    sendTyping: runtimeMocks.sendTyping,
    getState: () => ({
      currentDevicePubkey: sessionState.manager?.getDeviceId?.() || null,
      sessionManagerReady: true,
    }),
    getSessionUserRecords: () => sessionState.manager?.getUserRecords?.() || new Map(),
    onGroupEvent: () => () => {},
  }),
  waitForNdrRuntime: async () => ({
    sendEvent: runtimeMocks.sendEvent,
    sendReceipt: runtimeMocks.sendReceipt,
    sendTyping: runtimeMocks.sendTyping,
    setupUser: sessionState.manager?.setupUser,
  }),
  waitForSendReadyRuntime: async () => {
    await privateChatsMocks.ensureDeviceRegistered()
    return {
      sendEvent: runtimeMocks.sendEvent,
      sendReceipt: runtimeMocks.sendReceipt,
      sendTyping: runtimeMocks.sendTyping,
    }
  },
  preparePeerNdrRuntime: async (recipientPubkey: string) => {
    await privateChatsMocks.ensureDeviceRegistered()
    const manager = await privateChatsMocks.waitForSessionManager()
    await manager.setupUser(recipientPubkey)
    return {
      sendEvent: runtimeMocks.sendEvent,
      sendReceipt: runtimeMocks.sendReceipt,
      sendTyping: runtimeMocks.sendTyping,
    }
  },
  waitForPeerSendReadySessionManager: async (recipientPubkey: string) => {
    await privateChatsMocks.ensureDeviceRegistered()
    const manager = await privateChatsMocks.waitForSessionManager()
    await manager.setupUser(recipientPubkey)
    return manager
  },
  republishInvite: vi.fn().mockResolvedValue(undefined),
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

vi.mock('nostr-tools', async () => {
  const actual = await vi.importActual<typeof import('nostr-tools')>('nostr-tools')
  return {
    ...actual,
    getEventHash: vi.fn(() => 'mock-event-hash'),
  }
})

import {handleManagerEvent, chats, sendMessage} from './chat'
import {countUnseenMessages} from './unseenCount'
import {devices} from './devices'

beforeEach(() => {
  chats.set(new Map())
  devices.reset()
  typingMocks.setRemoteTyping.mockClear()
  typingMocks.clearRemoteTyping.mockClear()
  privateChatsMocks.ensureDeviceRegistered.mockReset()
  privateChatsMocks.ensureDeviceRegistered.mockResolvedValue(undefined)
  privateChatsMocks.waitForSessionManager.mockReset()
  privateChatsMocks.waitForSessionManager.mockImplementation(() =>
    Promise.reject(new Error('manager unavailable in test'))
  )
  runtimeMocks.sendEvent.mockReset()
  runtimeMocks.sendEvent.mockResolvedValue(undefined)
  runtimeMocks.sendReceipt.mockReset()
  runtimeMocks.sendReceipt.mockResolvedValue(undefined)
  runtimeMocks.sendTyping.mockReset()
  runtimeMocks.sendTyping.mockResolvedValue(undefined)
  sessionState.manager = null
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

  it('routes own sender copies with a linked-peer p-tag to the peer owner chat', async () => {
    const PEER_PUBKEY = 'c'.repeat(64)
    const PEER_LINKED_DEVICE = 'e'.repeat(64)

    sessionState.manager = {
      getUserRecords: () =>
        new Map([
          [
            PEER_PUBKEY,
            {
              devices: new Map([
                [
                  PEER_LINKED_DEVICE,
                  {
                    activeSession: null,
                    inactiveSessions: [],
                  },
                ],
              ]),
              appKeys: {
                getAllDevices: () => [{identityPubkey: PEER_LINKED_DEVICE}],
              },
            },
          ],
        ]),
    }

    const rumor = {
      id: 'msg-linked-peer-1',
      pubkey: MY_PUBKEY,
      content: 'hello linked peer',
      kind: CHAT_MESSAGE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', PEER_LINKED_DEVICE], ['ms', String(Date.now())]],
    }

    await handleManagerEvent(rumor as never, MY_PUBKEY, {
      isSelf: true,
      isCrossDeviceSelf: true,
    })

    const chatMap = get(chats)
    const peerChat = chatMap.get(PEER_PUBKEY)

    expect(peerChat).toBeTruthy()
    expect(peerChat?.messages).toHaveLength(1)
    expect(peerChat?.messages[0].content).toBe('hello linked peer')
    expect(peerChat?.messages[0].isMine).toBe(true)
    expect(chatMap.get(PEER_LINKED_DEVICE)).toBeUndefined()
  })

  it('routes self-origin copies with a peer p-tag to the peer chat even before device state catches up', async () => {
    const PEER_PUBKEY = 'c'.repeat(64)
    const OWN_OTHER_DEVICE = 'd'.repeat(64)

    const rumor = {
      id: 'msg-self-peer-routing-lag',
      pubkey: OWN_OTHER_DEVICE,
      content: 'hello peer despite stale device state',
      kind: CHAT_MESSAGE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', PEER_PUBKEY], ['ms', String(Date.now())]],
    }

    await handleManagerEvent(rumor as never, OWN_OTHER_DEVICE, {
      isSelf: true,
      isCrossDeviceSelf: true,
      senderOwnerPubkey: MY_PUBKEY,
      senderDevicePubkey: OWN_OTHER_DEVICE,
      fromDeviceId: OWN_OTHER_DEVICE,
      origin: 'same-owner-other-device',
    })

    const chatMap = get(chats)
    const peerChat = chatMap.get(PEER_PUBKEY)

    expect(peerChat).toBeTruthy()
    expect(peerChat?.messages).toHaveLength(1)
    expect(peerChat?.messages[0].content).toBe('hello peer despite stale device state')
    expect(peerChat?.messages[0].isMine).toBe(true)
    expect(chatMap.get(MY_PUBKEY)).toBeUndefined()
  })

  it('marks self-targeted sender copies from another client as mine when sender owner resolves to us', async () => {
    const OWN_OTHER_DEVICE = 'd'.repeat(64)

    const rumor = {
      id: 'msg-self-targeted-owner-meta',
      pubkey: OWN_OTHER_DEVICE,
      content: 'hello from another app to self',
      kind: CHAT_MESSAGE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', MY_PUBKEY], ['ms', String(Date.now())]],
    }

    await handleManagerEvent(rumor as never, OWN_OTHER_DEVICE, {
      senderOwnerPubkey: MY_PUBKEY,
      senderDevicePubkey: OWN_OTHER_DEVICE,
      fromDeviceId: OWN_OTHER_DEVICE,
      origin: 'same-owner-other-device',
    })

    const chatMap = get(chats)
    const selfChat = chatMap.get(MY_PUBKEY)

    expect(selfChat).toBeTruthy()
    expect(selfChat?.messages).toHaveLength(1)
    expect(selfChat?.messages[0]).toMatchObject({
      id: 'msg-self-targeted-owner-meta',
      content: 'hello from another app to self',
      isMine: true,
    })
    expect(countUnseenMessages(selfChat?.messages || [])).toBe(0)
  })

  it('bootstraps peer setup when a self-copy creates a new peer chat', async () => {
    const PEER_PUBKEY = 'c'.repeat(64)
    const setupUser = vi.fn().mockResolvedValue(undefined)
    privateChatsMocks.waitForSessionManager.mockResolvedValue({
      setupUser,
    } as never)

    const rumor = {
      id: 'msg-bootstrap-peer',
      pubkey: MY_PUBKEY,
      content: 'hello peer bootstrap',
      kind: CHAT_MESSAGE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', PEER_PUBKEY], ['ms', String(Date.now())]],
    }

    await handleManagerEvent(rumor as never, MY_PUBKEY, {
      isSelf: true,
      isCrossDeviceSelf: true,
    })
    await vi.waitFor(() =>
      expect(privateChatsMocks.ensureDeviceRegistered).toHaveBeenCalledTimes(1)
    )

    expect(privateChatsMocks.waitForSessionManager).toHaveBeenCalled()
    await vi.waitFor(() => expect(setupUser).toHaveBeenCalledWith(PEER_PUBKEY))
  })

  it('routes incoming peer linked-device messages to the peer owner chat', async () => {
    const PEER_PUBKEY = 'c'.repeat(64)
    const PEER_LINKED_DEVICE = 'f'.repeat(64)

    sessionState.manager = {
      getUserRecords: () =>
        new Map([
          [
            PEER_PUBKEY,
            {
              devices: new Map([
                [
                  PEER_LINKED_DEVICE,
                  {
                    activeSession: null,
                    inactiveSessions: [],
                  },
                ],
              ]),
              appKeys: {
                getAllDevices: () => [{identityPubkey: PEER_LINKED_DEVICE}],
              },
            },
          ],
        ]),
    }

    const rumor = {
      id: 'msg-linked-peer-2',
      pubkey: '1'.repeat(64),
      content: 'hello from linked peer device',
      kind: CHAT_MESSAGE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', MY_PUBKEY], ['ms', String(Date.now())]],
    }

    await handleManagerEvent(rumor as never, PEER_LINKED_DEVICE)

    const chatMap = get(chats)
    const peerChat = chatMap.get(PEER_PUBKEY)

    expect(peerChat).toBeTruthy()
    expect(peerChat?.messages).toHaveLength(1)
    expect(peerChat?.messages[0].content).toBe('hello from linked peer device')
    expect(peerChat?.messages[0].isMine).toBe(false)
    expect(chatMap.get(PEER_LINKED_DEVICE)).toBeUndefined()
  })

  it('merges provisional linked-device chats into the peer owner chat once owner mapping is known', async () => {
    const PEER_PUBKEY = 'c'.repeat(64)
    const PEER_LINKED_DEVICE = 'f'.repeat(64)

    chats.set(
      new Map([
        [
          PEER_LINKED_DEVICE,
          {
            id: PEER_LINKED_DEVICE,
            recipientPubkey: PEER_LINKED_DEVICE,
            mode: 'manager',
            messages: [
              {
                id: 'old-device-chat-msg',
                content: 'hello from provisional device chat',
                timestamp: 1,
                isMine: false,
              },
            ],
          },
        ],
      ])
    )

    sessionState.manager = {
      getUserRecords: () =>
        new Map([
          [
            PEER_PUBKEY,
            {
              devices: new Map([
                [
                  PEER_LINKED_DEVICE,
                  {
                    activeSession: null,
                    inactiveSessions: [],
                  },
                ],
              ]),
              appKeys: {
                getAllDevices: () => [{identityPubkey: PEER_LINKED_DEVICE}],
              },
            },
          ],
        ]),
    }

    const rumor = {
      id: 'msg-linked-peer-merge',
      pubkey: '1'.repeat(64),
      content: 'hello after owner mapping',
      kind: CHAT_MESSAGE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', MY_PUBKEY], ['ms', String(Date.now())]],
    }

    await handleManagerEvent(rumor as never, PEER_PUBKEY)

    const chatMap = get(chats)
    const peerChat = chatMap.get(PEER_PUBKEY)

    expect(peerChat).toBeTruthy()
    expect(chatMap.get(PEER_LINKED_DEVICE)).toBeUndefined()
    expect(peerChat?.messages.map((message) => message.content)).toEqual([
      'hello from provisional device chat',
      'hello after owner mapping',
    ])
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

  it('ignores typing events from our own linked devices', async () => {
    const PEER_PUBKEY = 'c'.repeat(64)
    const OWN_OTHER_DEVICE = 'd'.repeat(64)

    const rumor = {
      id: 'typing-own-device-1',
      pubkey: OWN_OTHER_DEVICE,
      content: 'typing',
      kind: TYPING_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', PEER_PUBKEY], ['ms', String(Date.now())]],
    }

    await handleManagerEvent(rumor as never, OWN_OTHER_DEVICE, {
      isSelf: true,
      isCrossDeviceSelf: true,
      senderOwnerPubkey: MY_PUBKEY,
      senderDevicePubkey: OWN_OTHER_DEVICE,
      fromDeviceId: OWN_OTHER_DEVICE,
      origin: 'same-owner-other-device',
    })

    expect(typingMocks.setRemoteTyping).not.toHaveBeenCalled()
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

  it('waits for current-device registration before sending via runtime', async () => {
    let resolveRegistration!: () => void
    const registrationReady = new Promise<void>((resolve) => {
      resolveRegistration = resolve
    })

    privateChatsMocks.ensureDeviceRegistered.mockReturnValue(registrationReady)

    chats.set(
      new Map([
        [
          MY_PUBKEY,
          {
            id: MY_PUBKEY,
            recipientPubkey: MY_PUBKEY,
            mode: 'manager',
            messages: [],
          },
        ],
      ])
    )

    sendMessage(get(chats).get(MY_PUBKEY)!, 'register before send')

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(privateChatsMocks.ensureDeviceRegistered).toHaveBeenCalledTimes(1)
    expect(runtimeMocks.sendEvent).not.toHaveBeenCalled()

    resolveRegistration()
    await vi.waitFor(() => expect(runtimeMocks.sendEvent).toHaveBeenCalledTimes(1))
    expect(runtimeMocks.sendEvent.mock.calls[0]?.[0]).toBe(MY_PUBKEY)
    expect(runtimeMocks.sendEvent.mock.calls[0]?.[1]).toMatchObject({
      pubkey: MY_PUBKEY,
      content: 'register before send',
    })
  })

  it('delegates first peer message sends to the runtime', async () => {
    const PEER_PUBKEY = 'c'.repeat(64)

    chats.set(
      new Map([
        [
          PEER_PUBKEY,
          {
            id: PEER_PUBKEY,
            recipientPubkey: PEER_PUBKEY,
            mode: 'manager',
            messages: [],
          },
        ],
      ])
    )

    sendMessage(get(chats).get(PEER_PUBKEY)!, 'linked first send waits for setup')

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(runtimeMocks.sendEvent).toHaveBeenCalledTimes(1)
    expect(runtimeMocks.sendEvent.mock.calls[0]?.[0]).toBe(PEER_PUBKEY)
    expect(runtimeMocks.sendEvent.mock.calls[0]?.[1]).toMatchObject({
      pubkey: MY_PUBKEY,
      content: 'linked first send waits for setup',
    })
  })

  it('uses the current device pubkey when sending manager rumors from a linked device', async () => {
    const LINKED_DEVICE_PUBKEY = 'b'.repeat(64)
    const PEER_PUBKEY = 'c'.repeat(64)

    devices.setIdentityPubkey(LINKED_DEVICE_PUBKEY)

    chats.set(
      new Map([
        [
          PEER_PUBKEY,
          {
            id: PEER_PUBKEY,
            recipientPubkey: PEER_PUBKEY,
            mode: 'manager',
            messages: [],
          },
        ],
      ])
    )

    sendMessage(get(chats).get(PEER_PUBKEY)!, 'send from linked device')

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(runtimeMocks.sendEvent).toHaveBeenCalledTimes(1)
    expect(runtimeMocks.sendEvent.mock.calls[0]?.[0]).toBe(PEER_PUBKEY)
    expect(runtimeMocks.sendEvent.mock.calls[0]?.[1]).toMatchObject({
      pubkey: LINKED_DEVICE_PUBKEY,
      content: 'send from linked device',
    })
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { get, writable } from 'svelte/store'

// --- Mocks ---

const mockDeleteMessage = vi.fn().mockResolvedValue(undefined)

vi.mock('./storage', () => ({
  deleteMessage: (...args: unknown[]) => mockDeleteMessage(...args),
}))

// Create writable stores that we control
const mockChats = writable(new Map())
const mockCurrentChat = writable(null)
const mockGroupMessages = writable(new Map())

vi.mock('./chat', () => ({
  chats: mockChats,
  currentChat: mockCurrentChat,
}))

vi.mock('./groups', () => ({
  groupMessages: mockGroupMessages,
}))

// Mock the NDR expiration functions
const mockGetExpirationTimestampSeconds = vi.fn()
const mockIsExpired = vi.fn()

vi.mock('nostr-double-ratchet', () => ({
  getExpirationTimestampSeconds: (...args: unknown[]) => mockGetExpirationTimestampSeconds(...args),
  isExpired: (...args: unknown[]) => mockIsExpired(...args),
}))

// --- Tests ---

describe('messageExpirationCleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    mockChats.set(new Map())
    mockCurrentChat.set(null)
    mockGroupMessages.set(new Map())
    mockDeleteMessage.mockClear()
    mockGetExpirationTimestampSeconds.mockReset()
    mockIsExpired.mockReset()
  })

  afterEach(async () => {
    // Stop cleanup if running
    const mod = await import('./messageExpirationCleanup')
    mod.stopMessageExpirationCleanup()
    vi.useRealTimers()
  })

  it('starts and stops without error', async () => {
    const { startMessageExpirationCleanup, stopMessageExpirationCleanup } = await import('./messageExpirationCleanup')
    startMessageExpirationCleanup()
    stopMessageExpirationCleanup()
  })

  it('removes expired DM messages from chats store', async () => {
    const now = Math.floor(Date.now() / 1000)

    // Set up a chat with one expired and one non-expired message
    const chatSession = {
      id: 'peer1',
      recipientPubkey: 'peer1',
      messages: [
        { id: 'msg1', content: 'expired message', expiresAt: now - 10, isMine: false, timestamp: now - 100 },
        { id: 'msg2', content: 'fresh message', timestamp: now, isMine: false },
      ],
    }
    mockChats.set(new Map([['peer1', chatSession]]))

    // Configure NDR mocks
    mockGetExpirationTimestampSeconds.mockImplementation((event: { tags?: string[][] }) => {
      const tag = event.tags?.find((t) => t[0] === 'expiration')
      return tag ? parseInt(tag[1]) : undefined
    })
    mockIsExpired.mockImplementation((event: { tags?: string[][] }, nowSec: number) => {
      const tag = event.tags?.find((t) => t[0] === 'expiration')
      if (!tag) return false
      return parseInt(tag[1]) <= nowSec
    })

    const { startMessageExpirationCleanup } = await import('./messageExpirationCleanup')
    startMessageExpirationCleanup()

    // Advance past the initial 2s delay
    await vi.advanceTimersByTimeAsync(2100)

    // Check that the expired message was removed
    const updatedChats = get(mockChats)
    const chat = updatedChats.get('peer1')
    expect(chat).toBeDefined()
    expect(chat!.messages).toHaveLength(1)
    expect(chat!.messages[0].id).toBe('msg2')

    // Check DB deletion was called
    expect(mockDeleteMessage).toHaveBeenCalledWith('msg1')
    expect(mockDeleteMessage).not.toHaveBeenCalledWith('msg2')
  })

  it('removes expired group messages', async () => {
    const now = Math.floor(Date.now() / 1000)

    const messages = [
      { id: 'gmsg1', content: 'expired group msg', expiresAt: now - 5, isMine: false, timestamp: now - 100, senderPubkey: 'abc' },
      { id: 'gmsg2', content: 'valid group msg', isMine: true, timestamp: now, senderPubkey: 'me' },
    ]
    mockGroupMessages.set(new Map([['group1', messages]]))

    mockGetExpirationTimestampSeconds.mockImplementation((event: { tags?: string[][] }) => {
      const tag = event.tags?.find((t) => t[0] === 'expiration')
      return tag ? parseInt(tag[1]) : undefined
    })
    mockIsExpired.mockImplementation((event: { tags?: string[][] }, nowSec: number) => {
      const tag = event.tags?.find((t) => t[0] === 'expiration')
      if (!tag) return false
      return parseInt(tag[1]) <= nowSec
    })

    const { startMessageExpirationCleanup } = await import('./messageExpirationCleanup')
    startMessageExpirationCleanup()

    await vi.advanceTimersByTimeAsync(2100)

    const updatedGm = get(mockGroupMessages)
    const groupMsgs = updatedGm.get('group1')
    expect(groupMsgs).toHaveLength(1)
    expect(groupMsgs![0].id).toBe('gmsg2')

    expect(mockDeleteMessage).toHaveBeenCalledWith('gmsg1')
  })

  it('does not remove messages without expiration', async () => {
    const now = Math.floor(Date.now() / 1000)

    const chatSession = {
      id: 'peer2',
      recipientPubkey: 'peer2',
      messages: [
        { id: 'msg-no-exp', content: 'no expiry', timestamp: now, isMine: false },
      ],
    }
    mockChats.set(new Map([['peer2', chatSession]]))

    mockGetExpirationTimestampSeconds.mockReturnValue(undefined)
    mockIsExpired.mockReturnValue(false)

    const { startMessageExpirationCleanup } = await import('./messageExpirationCleanup')
    startMessageExpirationCleanup()

    await vi.advanceTimersByTimeAsync(2100)

    const updatedChats = get(mockChats)
    const chat = updatedChats.get('peer2')
    expect(chat!.messages).toHaveLength(1)
    expect(mockDeleteMessage).not.toHaveBeenCalled()
  })

  it('does not start twice', async () => {
    mockGetExpirationTimestampSeconds.mockReturnValue(undefined)
    mockIsExpired.mockReturnValue(false)

    const { startMessageExpirationCleanup } = await import('./messageExpirationCleanup')
    startMessageExpirationCleanup()
    startMessageExpirationCleanup() // second call should be no-op

    // Just verify it doesn't throw
    await vi.advanceTimersByTimeAsync(2100)
  })

  it('can be restarted after stopping', async () => {
    mockGetExpirationTimestampSeconds.mockReturnValue(undefined)
    mockIsExpired.mockReturnValue(false)

    const { startMessageExpirationCleanup, stopMessageExpirationCleanup } = await import('./messageExpirationCleanup')
    startMessageExpirationCleanup()
    stopMessageExpirationCleanup()
    startMessageExpirationCleanup()

    // Should work fine
    await vi.advanceTimersByTimeAsync(2100)
  })
})

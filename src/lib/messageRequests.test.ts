import { describe, it, expect, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'

const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  key: vi.fn(),
  length: 0,
}
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock })

describe('messageRequests', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorageMock.getItem.mockReset()
    localStorageMock.setItem.mockReset()
  })

  it('should default to empty accepted/rejected maps', async () => {
    const { messageRequests } = await import('./messageRequests')
    const state = get(messageRequests)
    expect(state.acceptedChats).toEqual({})
    expect(state.rejectedChats).toEqual({})
  })

  it('acceptChat should add to accepted and remove from rejected', async () => {
    const { messageRequests, acceptChat, rejectChat } = await import('./messageRequests')
    const chatId = 'a'.repeat(64)

    rejectChat(chatId)
    acceptChat(chatId)

    const state = get(messageRequests)
    expect(state.acceptedChats[chatId]).toBe(true)
    expect(state.rejectedChats[chatId]).toBeUndefined()
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'iris-chat-message-request-decisions',
      expect.stringContaining(chatId)
    )
  })

  it('rejectChat should add to rejected and remove from accepted', async () => {
    const { messageRequests, acceptChat, rejectChat } = await import('./messageRequests')
    const chatId = 'b'.repeat(64)

    acceptChat(chatId)
    rejectChat(chatId)

    const state = get(messageRequests)
    expect(state.rejectedChats[chatId]).toBe(true)
    expect(state.acceptedChats[chatId]).toBeUndefined()
  })

  it('clearChat should remove from both maps', async () => {
    const { messageRequests, acceptChat, rejectChat, clearChat } = await import('./messageRequests')
    const chatId = 'c'.repeat(64)

    acceptChat(chatId)
    rejectChat('d'.repeat(64))
    clearChat(chatId)

    const state = get(messageRequests)
    expect(state.acceptedChats[chatId]).toBeUndefined()
    expect(state.rejectedChats[chatId]).toBeUndefined()
  })

  it('orders sibling activity by its original time and preserves later rejections', async () => {
    const { loadMessageRequestDecisions, mergeRequestDecision, acceptChatFromActivity, requestDecisionStates } = await import('./messageRequests')
    const owner = 'a'.repeat(64), peer = 'b'.repeat(64)
    loadMessageRequestDecisions(owner)
    mergeRequestDecision(owner, { chatId: peer, decision: 'rejected', updatedAtMs: 2000 })
    expect(acceptChatFromActivity(owner, peer, 1000)).toBe(false)
    expect(acceptChatFromActivity(owner, peer, 2000)).toBe(false)
    expect(acceptChatFromActivity(owner, peer, 3000)).toBe(true)
    expect(requestDecisionStates(owner)).toEqual([{ chatId: peer, decision: 'accepted', updatedAtMs: 3000 }])
    expect(acceptChatFromActivity(owner, peer, 3000)).toBe(false)
    expect(acceptChatFromActivity('c'.repeat(64), peer, 4000)).toBe(false)
  })

  it('does not accept activity from blocked people or invalid future timestamps', async () => {
    const { loadMessageRequestDecisions, acceptChatFromActivity, requestDecisionStates } = await import('./messageRequests')
    const { replaceBlockedContacts } = await import('./privateBlockProjection')
    const owner = 'a'.repeat(64), peer = 'b'.repeat(64)
    loadMessageRequestDecisions(owner)
    replaceBlockedContacts(owner, new Set([peer]))
    expect(acceptChatFromActivity(owner, peer, 1000)).toBe(false)
    replaceBlockedContacts(owner, new Set())
    expect(acceptChatFromActivity(owner, peer, Date.now() + 600_000)).toBe(false)
    expect(requestDecisionStates(owner)).toEqual([])
  })
})


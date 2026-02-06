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
})


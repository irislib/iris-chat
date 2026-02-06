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

describe('messageRequestSettings', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorageMock.getItem.mockReset()
    localStorageMock.setItem.mockReset()
  })

  it('should default to receiveMessageRequests enabled', async () => {
    const { messageRequestSettings } = await import('./messageRequestSettings')
    const settings = get(messageRequestSettings)
    expect(settings.receiveMessageRequests).toBe(true)
  })

  it('should persist receiveMessageRequests to localStorage', async () => {
    const { setReceiveMessageRequests } = await import('./messageRequestSettings')
    setReceiveMessageRequests(false)
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'iris-chat-message-requests',
      expect.stringContaining('"receiveMessageRequests":false')
    )
  })

  it('should load saved settings from localStorage', async () => {
    localStorageMock.getItem.mockReturnValueOnce(JSON.stringify({ receiveMessageRequests: false }))
    const { messageRequestSettings } = await import('./messageRequestSettings')
    const settings = get(messageRequestSettings)
    expect(settings.receiveMessageRequests).toBe(false)
  })
})


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

describe('typingSettings', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorageMock.getItem.mockReset()
    localStorageMock.setItem.mockReset()
  })

  it('should default to sendTypingIndicators enabled', async () => {
    const { typingSettings } = await import('./typingSettings')
    const settings = get(typingSettings)
    expect(settings.sendTypingIndicators).toBe(true)
  })

  it('should persist to localStorage', async () => {
    const { setSendTypingIndicators } = await import('./typingSettings')
    setSendTypingIndicators(false)
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'iris-chat-typing',
      expect.stringContaining('"sendTypingIndicators":false')
    )
  })

  it('should load saved settings from localStorage', async () => {
    localStorageMock.getItem.mockReturnValueOnce(JSON.stringify({ sendTypingIndicators: false }))
    const { typingSettings } = await import('./typingSettings')
    const settings = get(typingSettings)
    expect(settings.sendTypingIndicators).toBe(false)
  })
})

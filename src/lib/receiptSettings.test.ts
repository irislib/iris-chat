import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { store = {} }),
  }
})()
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock })

describe('receiptSettings', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.resetModules()
  })

  it('should default to sendReceipts: true', async () => {
    const { receiptSettings } = await import('./receiptSettings')
    const { get } = await import('svelte/store')
    expect(get(receiptSettings).sendReceipts).toBe(true)
  })

  it('should persist sendReceipts to localStorage', async () => {
    const { setSendReceipts } = await import('./receiptSettings')
    setSendReceipts(false)
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'iris-chat-receipts',
      expect.stringContaining('"sendReceipts":false')
    )
  })

  it('should load persisted settings from localStorage', async () => {
    localStorageMock.getItem.mockReturnValueOnce(JSON.stringify({ sendReceipts: false }))
    const { receiptSettings } = await import('./receiptSettings')
    const { get } = await import('svelte/store')
    expect(get(receiptSettings).sendReceipts).toBe(false)
  })
})

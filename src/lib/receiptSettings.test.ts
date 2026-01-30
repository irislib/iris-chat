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

describe('receiptSettings', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorageMock.getItem.mockReset()
    localStorageMock.setItem.mockReset()
  })

  it('should default to both receipts enabled', async () => {
    const { receiptSettings } = await import('./receiptSettings')
    const settings = get(receiptSettings)
    expect(settings.sendDeliveryReceipts).toBe(true)
    expect(settings.sendReadReceipts).toBe(true)
  })

  it('should persist sendDeliveryReceipts to localStorage', async () => {
    const { setSendDeliveryReceipts } = await import('./receiptSettings')
    setSendDeliveryReceipts(false)
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'iris-chat-receipts',
      expect.stringContaining('"sendDeliveryReceipts":false')
    )
  })

  it('should persist sendReadReceipts to localStorage', async () => {
    const { setSendReadReceipts } = await import('./receiptSettings')
    setSendReadReceipts(false)
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'iris-chat-receipts',
      expect.stringContaining('"sendReadReceipts":false')
    )
  })

  it('should load saved settings from localStorage', async () => {
    localStorageMock.getItem.mockReturnValueOnce(JSON.stringify({ sendDeliveryReceipts: false, sendReadReceipts: true }))
    const { receiptSettings } = await import('./receiptSettings')
    const settings = get(receiptSettings)
    expect(settings.sendDeliveryReceipts).toBe(false)
    expect(settings.sendReadReceipts).toBe(true)
  })

  it('should migrate old single-toggle format', async () => {
    localStorageMock.getItem.mockReturnValueOnce(JSON.stringify({ sendReceipts: false }))
    const { receiptSettings } = await import('./receiptSettings')
    const settings = get(receiptSettings)
    expect(settings.sendDeliveryReceipts).toBe(false)
    expect(settings.sendReadReceipts).toBe(false)
  })
})

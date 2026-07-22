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

  it('should default to both receipts disabled', async () => {
    const { receiptSettings } = await import('./receiptSettings')
    const settings = get(receiptSettings)
    expect(settings.sendDeliveryReceipts).toBe(false)
    expect(settings.sendReadReceipts).toBe(false)
  })

  it('should persist sendDeliveryReceipts to localStorage', async () => {
    const { setSendDeliveryReceipts } = await import('./receiptSettings')
    setSendDeliveryReceipts(true)
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'iris-chat-receipts',
      expect.stringContaining('"sendDeliveryReceipts":true')
    )
  })

  it('should persist sendReadReceipts to localStorage', async () => {
    const { setSendReadReceipts } = await import('./receiptSettings')
    setSendReadReceipts(true)
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'iris-chat-receipts',
      expect.stringContaining('"sendReadReceipts":true')
    )
  })

  it('should load saved settings from localStorage', async () => {
    localStorageMock.getItem.mockReturnValueOnce(JSON.stringify({ sendDeliveryReceipts: false, sendReadReceipts: true }))
    const { receiptSettings } = await import('./receiptSettings')
    const settings = get(receiptSettings)
    expect(settings.sendDeliveryReceipts).toBe(false)
    expect(settings.sendReadReceipts).toBe(true)
  })

  it('should fill missing saved settings from defaults', async () => {
    localStorageMock.getItem.mockReturnValueOnce(JSON.stringify({ sendDeliveryReceipts: true }))
    const { receiptSettings } = await import('./receiptSettings')
    const settings = get(receiptSettings)
    expect(settings.sendDeliveryReceipts).toBe(true)
    expect(settings.sendReadReceipts).toBe(false)
  })

  it('should still update when localStorage is unavailable', async () => {
    localStorageMock.setItem.mockImplementationOnce(() => {
      throw new Error('storage unavailable')
    })
    const { receiptSettings, setSendDeliveryReceipts } = await import('./receiptSettings')
    expect(() => setSendDeliveryReceipts(true)).not.toThrow()
    expect(get(receiptSettings).sendDeliveryReceipts).toBe(true)
  })

  it('should migrate old single-toggle format', async () => {
    localStorageMock.getItem.mockReturnValueOnce(JSON.stringify({ sendReceipts: false }))
    const { receiptSettings } = await import('./receiptSettings')
    const settings = get(receiptSettings)
    expect(settings.sendDeliveryReceipts).toBe(false)
    expect(settings.sendReadReceipts).toBe(false)
  })
})

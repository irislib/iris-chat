import { describe, it, expect } from 'vitest'
import { shouldAdvanceStatus } from './receipts'

describe('receipt payloads', () => {
  describe('shouldAdvanceStatus', () => {
    it('should advance from undefined to delivered', () => {
      expect(shouldAdvanceStatus(undefined, 'delivered')).toBe(true)
    })

    it('should advance from undefined to seen', () => {
      expect(shouldAdvanceStatus(undefined, 'seen')).toBe(true)
    })

    it('should advance from delivered to seen', () => {
      expect(shouldAdvanceStatus('delivered', 'seen')).toBe(true)
    })

    it('should not go backwards from seen to delivered', () => {
      expect(shouldAdvanceStatus('seen', 'delivered')).toBe(false)
    })

    it('should not advance from delivered to delivered', () => {
      expect(shouldAdvanceStatus('delivered', 'delivered')).toBe(false)
    })

    it('should not advance from seen to seen', () => {
      expect(shouldAdvanceStatus('seen', 'seen')).toBe(false)
    })
  })
})

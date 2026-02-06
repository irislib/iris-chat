import {describe, expect, it} from 'vitest'
import {countUnseenMessages, formatUnseenCount} from './unseenCount'

describe('unseenCount', () => {
  describe('countUnseenMessages', () => {
    it('counts incoming messages that are not marked seen', () => {
      const messages = [
        {isMine: false, status: undefined},
        {isMine: false, status: 'delivered'},
        {isMine: false, status: 'seen'},
        {isMine: true, status: undefined},
      ]

      expect(countUnseenMessages(messages)).toBe(2)
    })
  })

  describe('formatUnseenCount', () => {
    it('caps at 99+', () => {
      expect(formatUnseenCount(0)).toBe('0')
      expect(formatUnseenCount(1)).toBe('1')
      expect(formatUnseenCount(99)).toBe('99')
      expect(formatUnseenCount(100)).toBe('99+')
    })
  })
})


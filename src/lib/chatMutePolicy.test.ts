import { describe, expect, it } from 'vitest'
import { isChatMuted, mutedMessageFilters, normalizeChatMutes } from './chatMutePolicy'

describe('chat mute policy', () => {
  it('honors the exact deadline independently of foreground timers and preserves indefinite mutes', () => {
    const state = normalizeChatMutes({ a: 200, b: 0, corrupt: -1, bad: '200' })
    expect(isChatMuted(state, 'a', 199)).toBe(true)
    expect(isChatMuted(state, 'a', 200)).toBe(false)
    expect(isChatMuted(state, 'b', 1e10)).toBe(true)
    expect(isChatMuted(state, 'missing', 1)).toBe(false)
    expect(state).toEqual({ a: 200, b: 0 })
  })
  it('bounds all rotating authors for one chat without muting another chat', () => {
    const authors = new Map([['a', ['current-a', 'next-a']], ['b', ['current-b']]])
    expect(mutedMessageFilters(authors, { a: 200 }, 1060, true, 100)).toEqual([
      { kinds: [1060], authors: ['current-b'] },
      { kinds: [1060], authors: ['current-a', 'next-a'], since: 200 },
    ])
    expect(mutedMessageFilters(authors, { a: 200 }, 1060, true, 200)).toEqual([
      { kinds: [1060], authors: ['current-a', 'current-b', 'next-a'] },
    ])
  })
  it('old servers remain silent instead of subscribing without the missing time bound', () => {
    expect(mutedMessageFilters(new Map([['a', ['current-a']]]), { a: 200 }, 1060, false, 100))
      .toEqual([{ kinds: [1060], authors: [] }])
    expect(mutedMessageFilters(new Map([['a', ['current-a']]]), { a: 0 }, 1060, true, 1e10))
      .toEqual([{ kinds: [1060], authors: [] }])
  })
})

import { describe, it, expect } from 'vitest'
import { buildDisappearingNotice } from './disappearingNotice'

describe('buildDisappearingNotice', () => {
  it('returns an off notice for unset or non-positive values', () => {
    expect(buildDisappearingNotice(undefined)).toBe('Disappearing messages turned off')
    expect(buildDisappearingNotice(null)).toBe('Disappearing messages turned off')
    expect(buildDisappearingNotice(0)).toBe('Disappearing messages turned off')
    expect(buildDisappearingNotice(-10)).toBe('Disappearing messages turned off')
  })

  it('returns a human-friendly notice when ttl is enabled', () => {
    expect(buildDisappearingNotice(3600)).toBe('Disappearing messages set to 1 hour')
    expect(buildDisappearingNotice(172800)).toBe('Disappearing messages set to 2 days')
  })
})

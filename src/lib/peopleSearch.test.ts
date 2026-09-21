// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { mergePeopleProfiles, peopleSearchScore, peopleSearchKey } from './peopleSearch'

describe('people search ranking', () => {
  const profile = { pubkey: 'a'.repeat(64), name: 'Alice' }
  it('prefers nearby people and then support from friends for the same name', () => {
    const score = (followDistance: number, friendsFollowing = 0) => peopleSearchScore(profile, 'ali', { followDistance, friendsFollowing })
    expect(score(1)).toBeGreaterThan(score(2))
    expect(score(2, 2)).toBeGreaterThan(score(2, 1))
    expect(score(2)).toBeGreaterThan(score(Infinity))
  })
  it('keeps text relevance and requires prefix matches for a single character', () => {
    const signals = { followDistance: 2, friendsFollowing: 0 }
    expect(peopleSearchScore(profile, 'alice', signals)).toBeGreaterThan(peopleSearchScore({ ...profile, name: 'Alice Smith' }, 'alice', signals))
    expect(peopleSearchScore(profile, 'l', signals)).toBe(-Infinity)
    expect(peopleSearchScore(profile, 'a', signals)).toBeGreaterThan(-Infinity)
    expect(peopleSearchScore(profile, 'bob', signals)).toBe(-Infinity)
    expect(peopleSearchScore({ ...profile, nip05: 'alice@example.com' }, 'Alice example', signals)).toBeGreaterThan(-Infinity)
    expect(peopleSearchScore(profile, 'Alice missing', signals)).toBe(-Infinity)
  })
  it('normalizes deliberately pasted IDs separately from name discovery', () => {
    expect(peopleSearchKey('nostr:' + 'A'.repeat(64))).toBe('a'.repeat(64))
    expect(peopleSearchKey('Alice')).toBe(null)
  })
  it('does not resurrect an old matching name from a cached index result', () => {
    const old = { ...profile, eventCreatedAt: 1 }
    const renamed = { ...profile, name: 'Bob', eventCreatedAt: 2 }
    const merged = mergePeopleProfiles(new Map([[profile.pubkey, renamed]]), new Map([[profile.pubkey, old]]))
    expect(merged.get(profile.pubkey)).toEqual(renamed)
    expect(peopleSearchScore(merged.get(profile.pubkey), 'Alice', { followDistance: 1, friendsFollowing: 0 })).toBe(-Infinity)
  })
})

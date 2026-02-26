import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./storage', () => ({
  saveProfileToStorage: vi.fn().mockResolvedValue(undefined),
}))

import { saveLocalProfile, updateLocalProfile } from './profile'

describe('profile local editing', () => {
  const pubkey = 'f'.repeat(64)

  beforeEach(() => {
    localStorage.clear()
  })

  it('preserves name when adding a profile picture', () => {
    saveLocalProfile(pubkey, 'Alice')

    const updated = updateLocalProfile(pubkey, {
      picture: 'https://cdn.iris.to/alice.jpg',
    })

    expect(updated.name).toBe('Alice')
    expect(updated.display_name).toBe('Alice')
    expect(updated.picture).toBe('https://cdn.iris.to/alice.jpg')
  })

  it('preserves picture when updating name', () => {
    saveLocalProfile(pubkey, 'Alice')
    updateLocalProfile(pubkey, {
      picture: 'https://cdn.iris.to/alice.jpg',
    })

    const renamed = updateLocalProfile(pubkey, {
      name: 'Alice Cooper',
      display_name: 'Alice Cooper',
    })

    expect(renamed.name).toBe('Alice Cooper')
    expect(renamed.display_name).toBe('Alice Cooper')
    expect(renamed.picture).toBe('https://cdn.iris.to/alice.jpg')
  })
})

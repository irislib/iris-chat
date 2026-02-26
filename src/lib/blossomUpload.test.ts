import { describe, expect, it } from 'vitest'
import { buildBlossomUploadAuthEvent, normalizeBlossomUrl } from './blossomUpload'

describe('blossom upload helpers', () => {
  it('builds a valid blossom auth event', () => {
    const event = buildBlossomUploadAuthEvent({
      fileName: 'avatar.jpg',
      fileHash: 'a'.repeat(64),
      createdAt: 1_700_000_000,
    })

    expect(event.kind).toBe(24242)
    expect(event.content).toBe('avatar.jpg')
    expect(event.tags).toContainEqual(['t', 'upload'])
    expect(event.tags).toContainEqual(['x', 'a'.repeat(64)])
    expect(event.tags).toContainEqual(['expiration', '1700000300'])
  })

  it('normalizes blossom host to a read host', () => {
    expect(normalizeBlossomUrl('https://blossom.iris.to/abcd')).toBe('https://cdn.iris.to/abcd')
    expect(normalizeBlossomUrl('https://upload.iris.to/abcd')).toBe('https://cdn.iris.to/abcd')
    expect(normalizeBlossomUrl('https://example.com/abcd')).toBe('https://example.com/abcd')
  })
})

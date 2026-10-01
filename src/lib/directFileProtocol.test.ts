import { describe, expect, it } from 'vitest'
import { finalizeEvent, getPublicKey } from 'nostr-tools'
import { DIRECT_FILE_KIND, DIRECT_FILE_PREFIX, MAX_DIRECT_FILE_BYTES, directFilePreview,
  parseDirectFileOffer, signDirectFileOffer, type DirectFileOffer } from './directFileProtocol'
import { renderRumor } from './pushRumorRender'
import { CHAT_MESSAGE_KIND } from 'nostr-double-ratchet'

const secret = new Uint8Array(32).fill(1)
function offer(): DirectFileOffer {
  return { id: 'ab'.repeat(16), token: 'cd'.repeat(32), owner: '12'.repeat(32),
    recipient: '12'.repeat(32), device: getPublicKey(secret), caption: 'For my laptop',
    expires_at_secs: Math.floor(Date.now() / 1000) + 3600,
    files: [{ filename: 'empty.txt', size_bytes: 0, sha256: '34'.repeat(32) },
      { filename: 'photos.zip', size_bytes: 180123, sha256: '56'.repeat(32) }],
  }
}
function signed(value: unknown): string {
  return DIRECT_FILE_PREFIX + JSON.stringify(finalizeEvent({ kind: DIRECT_FILE_KIND,
    created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify(value) }, secret))
}

describe('native direct-file offer protocol', () => {
  it('preserves a signed multi-file self-offer and hides its capability from previews', () => {
    const value = offer()
    const wire = signDirectFileOffer(value, secret)
    expect(parseDirectFileOffer(wire)).toEqual(value)
    expect(directFilePreview(wire)).toBe('For my laptop')
    expect(renderRumor(CHAT_MESSAGE_KIND, wire)).toEqual({ body: 'For my laptop', durable: true })
    expect(directFilePreview(signed({ ...value, caption: '' }))).toBe('Direct files')
  })

  it('rejects tampering and a signed device claim for someone else', () => {
    expect(parseDirectFileOffer(signed(offer()).replace('For my laptop', 'Changed title'))).toBeUndefined()
    expect(parseDirectFileOffer(signed({ ...offer(), device: 'ab'.repeat(32) }))).toBeUndefined()
  })

  it.each(['../private', 'C:\\private', 'a/b', '.', '..', 'bad\nname', '🌈'.repeat(61)])(
    'rejects unsafe or oversized filename %j', (filename: string) => {
      const value = offer(); value.files[0]!.filename = filename
      expect(parseDirectFileOffer(signed(value))).toBeUndefined()
    })

  it('enforces native lifetime, file count, byte count and UTF-8 caption bounds', () => {
    const value = offer()
    expect(parseDirectFileOffer(signed({ ...value, expires_at_secs: Math.floor(Date.now() / 1000) + 86401 }))).toBeUndefined()
    expect(parseDirectFileOffer(signed({ ...value, files: [] }))).toBeUndefined()
    expect(parseDirectFileOffer(signed({ ...value, files: Array(33).fill(value.files[0]) }))).toBeUndefined()
    expect(parseDirectFileOffer(signed({ ...value, files: [{ ...value.files[0], size_bytes: MAX_DIRECT_FILE_BYTES + 1 }] }))).toBeUndefined()
    expect(parseDirectFileOffer(signed({ ...value, caption: '🌈'.repeat(1025) }))).toBeUndefined()
  })
})

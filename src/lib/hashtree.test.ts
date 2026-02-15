import { describe, it, expect } from 'vitest'
import { formatFileLink, parseFileLink, FILE_LINK_REGEX, isImageFile, getMimeType } from './hashtree'

describe('hashtree file links', () => {
  describe('formatFileLink', () => {
    it('should format simple filename', () => {
      const link = formatFileLink('nhash1abc123', 'test.jpg')
      expect(link).toBe('nhash1abc123/test.jpg')
    })

    it('should URL-encode spaces in filename', () => {
      const link = formatFileLink('nhash1abc123', 'hieno tanssi.mp4')
      expect(link).toBe('nhash1abc123/hieno%20tanssi.mp4')
    })

    it('should URL-encode special characters', () => {
      const link = formatFileLink('nhash1abc123', 'file (1).jpg')
      expect(link).toBe('nhash1abc123/file%20(1).jpg')
    })
  })

  describe('parseFileLink', () => {
    it('should parse simple filename', () => {
      const result = parseFileLink('nhash1abc123/test.jpg')
      expect(result).toEqual({ nhash: 'nhash1abc123', filename: 'test.jpg' })
    })

    it('should decode URL-encoded spaces', () => {
      const result = parseFileLink('nhash1abc123/hieno%20tanssi.mp4')
      expect(result).toEqual({ nhash: 'nhash1abc123', filename: 'hieno tanssi.mp4' })
    })

    it('should decode special characters', () => {
      const result = parseFileLink('nhash1abc123/file%20(1).jpg')
      expect(result).toEqual({ nhash: 'nhash1abc123', filename: 'file (1).jpg' })
    })

    it('should handle htree:// prefix', () => {
      const result = parseFileLink('htree://nhash1abc123/test.jpg')
      expect(result).toEqual({ nhash: 'nhash1abc123', filename: 'test.jpg' })
    })

    it('should return null for invalid links', () => {
      expect(parseFileLink('invalid')).toBeNull()
      expect(parseFileLink('npub1abc/test.jpg')).toBeNull()
    })
  })

  describe('FILE_LINK_REGEX', () => {
    it('should match file links in text', () => {
      const text = 'Check this out: nhash1abc123/test.jpg cool right?'
      const matches = [...text.matchAll(new RegExp(FILE_LINK_REGEX.source, 'gi'))]
      expect(matches).toHaveLength(1)
      expect(matches[0][1]).toBe('nhash1abc123')
      expect(matches[0][2]).toBe('test.jpg')
    })

    it('should match URL-encoded filenames without splitting on spaces', () => {
      const text = 'Video: nhash1abc123/hieno%20tanssi.mp4 enjoy!'
      const matches = [...text.matchAll(new RegExp(FILE_LINK_REGEX.source, 'gi'))]
      expect(matches).toHaveLength(1)
      expect(matches[0][1]).toBe('nhash1abc123')
      expect(decodeURIComponent(matches[0][2])).toBe('hieno tanssi.mp4')
    })

    it('should match multiple file links', () => {
      const text = 'nhash1abc/one.jpg and nhash1def/two.png'
      const matches = [...text.matchAll(new RegExp(FILE_LINK_REGEX.source, 'gi'))]
      expect(matches).toHaveLength(2)
    })

    it('should match htree:// prefix', () => {
      const text = 'htree://nhash1abc123/test.jpg'
      const matches = [...text.matchAll(new RegExp(FILE_LINK_REGEX.source, 'gi'))]
      expect(matches).toHaveLength(1)
      expect(matches[0][1]).toBe('nhash1abc123')
    })
  })

  describe('roundtrip', () => {
    it('should roundtrip filename with spaces', () => {
      const original = 'hieno tanssi.mp4'
      const link = formatFileLink('nhash1abc123', original)
      const parsed = parseFileLink(link)
      expect(parsed?.filename).toBe(original)
    })

    it('should roundtrip filename with special chars', () => {
      const original = 'file [test] (1).mp4'
      const link = formatFileLink('nhash1abc123', original)
      const parsed = parseFileLink(link)
      expect(parsed?.filename).toBe(original)
    })
  })

  describe('media type detection', () => {
    it('should treat AVIF files as images', () => {
      expect(isImageFile('photo.avif')).toBe(true)
    })

    it('should return AVIF mime type', () => {
      expect(getMimeType('photo.avif')).toBe('image/avif')
    })
  })
})

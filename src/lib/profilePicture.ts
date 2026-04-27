/**
 * Resolve profile picture URLs.
 *
 * Supports:
 * - htree:// and nhash:// URLs (encrypted hashtree files, decoded to blob URLs)
 * - http(s):// URLs (passed through imgproxy for resizing/caching)
 *
 * Used by Avatar, SettingsView profile preview, and group avatars.
 */

import { parseFileLink, getMediaUrl, isImageFile, getMimeType } from './hashtree'
import { generateProxyUrl, type ImgProxyOptions } from './imgproxy'

export function isHashtreePicture(picture: string | undefined | null): boolean {
  if (!picture) return false
  return picture.startsWith('htree://') || picture.startsWith('nhash://')
}

// Cache resolved URLs by source so repeated Avatar mounts (e.g. navigating back to
// the chat list) reuse the same blob/imgproxy URL and don't re-decode the image.
// Keyed by source URI + size variant since imgproxy URLs depend on dimensions.
const resolveCache = new Map<string, Promise<string | null>>()

function cacheKey(picture: string, options: ImgProxyOptions): string {
  if (isHashtreePicture(picture)) return picture
  return `${picture}|${options.width ?? ''}x${options.height ?? ''}|${options.square ? 's' : ''}`
}

export function resolvePictureUrl(
  picture: string | undefined | null,
  options: ImgProxyOptions = {}
): Promise<string | null> {
  if (!picture) return Promise.resolve(null)

  const key = cacheKey(picture, options)
  const cached = resolveCache.get(key)
  if (cached) return cached

  const promise = (async () => {
    if (isHashtreePicture(picture)) {
      const parsed = parseFileLink(picture)
      if (!parsed || !isImageFile(parsed.filename)) return null
      return getMediaUrl(parsed.nhash, getMimeType(parsed.filename))
    }
    return generateProxyUrl(picture, options)
  })()

  resolveCache.set(key, promise)
  promise.catch(() => resolveCache.delete(key))
  return promise
}

export function formatHtreePicture(nhash: string, filename: string): string {
  return `htree://${nhash}/${encodeURIComponent(filename)}`
}

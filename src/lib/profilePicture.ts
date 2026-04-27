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

export async function resolvePictureUrl(
  picture: string | undefined | null,
  options: ImgProxyOptions = {}
): Promise<string | null> {
  if (!picture) return null

  if (isHashtreePicture(picture)) {
    const parsed = parseFileLink(picture)
    if (!parsed || !isImageFile(parsed.filename)) return null
    return getMediaUrl(parsed.nhash, getMimeType(parsed.filename))
  }

  return generateProxyUrl(picture, options)
}

export function formatHtreePicture(nhash: string, filename: string): string {
  return `htree://${nhash}/${encodeURIComponent(filename)}`
}

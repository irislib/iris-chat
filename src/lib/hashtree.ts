/**
 * Hashtree integration for encrypted file sharing
 *
 * Uses @hashtree/core to upload files CHK-encrypted to Blossom servers
 * and generate nhash URLs for sharing in chat messages.
 */

import {
  HashTree,
  BlossomStore,
  nhashEncode,
  nhashDecode,
  isNHash,
  type BlossomSigner,
} from '@hashtree/core'
import { getPubkey, getPrivkeyBytes, isNip07Login } from './identity'
import { finalizeEvent } from 'nostr-tools'

// Default Blossom servers
const DEFAULT_BLOSSOM_SERVERS = [
  { url: 'https://upload.iris.to', write: true, read: false },
  { url: 'https://cdn.iris.to', write: false, read: true },
]

// Singleton instances
let blossomStore: BlossomStore | null = null
let hashTree: HashTree | null = null

/**
 * Create a Nostr signer for Blossom NIP-98 auth
 */
function createSigner(): BlossomSigner {
  return async (event) => {
    const privkeyBytes = getPrivkeyBytes()

    if (privkeyBytes) {
      // Local key signing - add pubkey to make it a full UnsignedEvent
      const fullEvent = {
        ...event,
        pubkey: getPubkey()!,
      }
      return finalizeEvent(fullEvent, privkeyBytes)
    }

    if (isNip07Login() && window.nostr?.signEvent) {
      // NIP-07 extension signing
      const signed = await window.nostr.signEvent(event as Parameters<typeof window.nostr.signEvent>[0])
      return signed as ReturnType<typeof finalizeEvent>
    }

    throw new Error('No signer available')
  }
}

/**
 * Get or create the HashTree instance
 */
function getHashTree(): HashTree {
  if (!hashTree) {
    const pubkey = getPubkey()
    if (!pubkey) {
      throw new Error('Not logged in')
    }

    blossomStore = new BlossomStore({
      servers: DEFAULT_BLOSSOM_SERVERS,
      signer: createSigner(),
    })

    hashTree = new HashTree({ store: blossomStore })
  }

  return hashTree
}

/**
 * Upload progress callback
 */
export type UploadProgressCallback = (bytesUploaded: number, totalBytes: number) => void

/**
 * Upload a file and return the nhash URL
 * Uses streaming for progress tracking
 */
export async function uploadFile(
  file: File,
  onProgress?: UploadProgressCallback
): Promise<{ nhash: string; filename: string }> {
  const tree = getHashTree()
  const totalBytes = file.size

  // Use streaming upload for progress tracking
  const stream = tree.createStream()
  const reader = file.stream().getReader()
  let bytesRead = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    await stream.append(value)
    bytesRead += value.length
    onProgress?.(bytesRead, totalBytes)
  }

  const result = await stream.finalize()

  // Construct CID from result
  const cid = result.key
    ? { hash: result.hash, key: result.key }
    : { hash: result.hash }

  const nhash = nhashEncode(cid)

  return {
    nhash,
    filename: file.name,
  }
}

/**
 * Download and decrypt a file from nhash
 */
export async function downloadFile(nhash: string): Promise<Uint8Array> {
  const tree = getHashTree()
  const cid = nhashDecode(nhash)
  const data = await tree.readFile(cid)
  if (!data) {
    throw new Error('File not found')
  }
  return data
}

/**
 * Get a blob URL for displaying media
 */
export async function getMediaUrl(nhash: string, mimeType?: string): Promise<string> {
  const data = await downloadFile(nhash)
  // Create a new ArrayBuffer to avoid SharedArrayBuffer issues
  const buffer = new ArrayBuffer(data.length)
  new Uint8Array(buffer).set(data)
  const blob = new Blob([buffer], { type: mimeType || 'application/octet-stream' })
  return URL.createObjectURL(blob)
}

/**
 * Format for sharing: nhash/filename (URL-encoded)
 */
export function formatFileLink(nhash: string, filename: string): string {
  return `${nhash}/${encodeURIComponent(filename)}`
}

/**
 * Parse a file link: nhash/filename or htree://nhash/filename
 */
export function parseFileLink(link: string): { nhash: string; filename: string } | null {
  // Remove htree:// prefix if present
  let cleaned = link
  if (cleaned.startsWith('htree://')) {
    cleaned = cleaned.substring(8)
  }

  // Match nhash1.../filename pattern
  const match = cleaned.match(/^(nhash1[a-z0-9]+)\/(.+)$/i)
  if (match) {
    return { nhash: match[1], filename: decodeURIComponent(match[2]) }
  }

  return null
}

/**
 * Regex to find file links in message content
 * Matches: nhash1.../filename or htree://nhash1.../filename
 * Filename is URL-encoded so we match until whitespace
 */
export const FILE_LINK_REGEX = /(?:htree:\/\/)?(nhash1[a-z0-9]+)\/([^\s]+)/gi

/**
 * Check if a filename is an image
 */
export function isImageFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase()
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'avif'].includes(ext || '')
}

/**
 * Check if a filename is a video
 */
export function isVideoFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase()
  return ['mp4', 'webm', 'mov', 'avi', 'mkv'].includes(ext || '')
}

/**
 * Check if a filename is audio
 */
export function isAudioFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase()
  return ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'].includes(ext || '')
}

/**
 * Get MIME type from filename
 */
export function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  const mimeTypes: Record<string, string> = {
    // Images
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    // Video
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
    // Audio
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    // Documents
    pdf: 'application/pdf',
    txt: 'text/plain',
    json: 'application/json',
  }
  return mimeTypes[ext || ''] || 'application/octet-stream'
}

// Re-export for convenience
export { isNHash }

import { finalizeEvent } from 'nostr-tools'
import { getPrivkeyBytes, getPubkey, isNip07Login } from './identity'

export const BLOSSOM_UPLOAD_AUTH_KIND = 24242

export interface BlossomUploadAuthEvent {
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

export interface BlossomUploadProgress {
  bytesUploaded: number
  totalBytes: number
}

export interface BlossomUploadOptions {
  servers?: string[]
  onProgress?: (progress: BlossomUploadProgress) => void
}

const DEFAULT_BLOSSOM_UPLOAD_SERVERS = [
  'https://blossom.iris.to',
  'https://upload.iris.to',
]

export function buildBlossomUploadAuthEvent(params: {
  fileName: string
  fileHash: string
  createdAt: number
}): BlossomUploadAuthEvent {
  const { fileName, fileHash, createdAt } = params
  return {
    kind: BLOSSOM_UPLOAD_AUTH_KIND,
    created_at: createdAt,
    tags: [
      ['t', 'upload'],
      ['x', fileHash],
      ['expiration', String(createdAt + 300)],
    ],
    content: fileName,
  }
}

export function normalizeBlossomUrl(url: string): string {
  return url
    .replace('://blossom.iris.to', '://cdn.iris.to')
    .replace('://upload.iris.to', '://cdn.iris.to')
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  const hash = await crypto.subtle.digest('SHA-256', buffer)
  return toHex(new Uint8Array(hash))
}

function toBase64(value: string): string {
  if (typeof btoa === 'function') return btoa(value)
  return Buffer.from(value, 'utf8').toString('base64')
}

async function signAuthEvent(event: BlossomUploadAuthEvent) {
  const privkeyBytes = getPrivkeyBytes()
  const pubkey = getPubkey()

  if (privkeyBytes && pubkey) {
    const fullEvent = {
      ...event,
      pubkey,
    }
    return finalizeEvent(
      fullEvent,
      privkeyBytes
    )
  }

  if (isNip07Login() && window.nostr?.signEvent) {
    return window.nostr.signEvent(
      event as Parameters<typeof window.nostr.signEvent>[0]
    )
  }

  throw new Error('No signer available for Blossom upload')
}

async function uploadToServer(
  file: File,
  uploadUrl: string,
  authHeaderValue: string,
  onProgress?: BlossomUploadOptions['onProgress'],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', uploadUrl)
    xhr.setRequestHeader('accept', 'application/json')
    xhr.setRequestHeader('authorization', authHeaderValue)
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream')

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return
      onProgress?.({
        bytesUploaded: event.loaded,
        totalBytes: event.total,
      })
    }

    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Upload failed (${xhr.status})`))
        return
      }

      try {
        const data = JSON.parse(xhr.responseText) as { url?: string }
        if (!data.url) {
          reject(new Error('Blossom response did not include url'))
          return
        }
        resolve(normalizeBlossomUrl(data.url))
      } catch (error) {
        reject(new Error(`Invalid Blossom response: ${String(error)}`))
      }
    }

    xhr.onerror = () => {
      reject(new Error(`Upload request failed for ${uploadUrl}`))
    }

    xhr.send(file)
  })
}

export async function uploadProfilePictureToBlossom(
  file: File,
  options: BlossomUploadOptions = {}
): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Profile picture must be an image')
  }

  const fileHash = await sha256Hex(file)
  const createdAt = Math.floor(Date.now() / 1000)
  const unsignedAuth = buildBlossomUploadAuthEvent({
    fileName: file.name,
    fileHash,
    createdAt,
  })
  const signedAuth = await signAuthEvent(unsignedAuth)
  const encodedAuth = toBase64(JSON.stringify(signedAuth))
  const authHeaderValue = `Nostr ${encodedAuth}`

  const servers = options.servers?.length
    ? options.servers
    : DEFAULT_BLOSSOM_UPLOAD_SERVERS

  const errors: string[] = []

  for (const server of servers) {
    const base = server.replace(/\/+$/, '')
    const uploadUrl = `${base}/upload`
    try {
      return await uploadToServer(file, uploadUrl, authHeaderValue, options.onProgress)
    } catch (error) {
      errors.push(`${base}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  throw new Error(`Blossom upload failed (${errors.join('; ')})`)
}

declare const window: Window & { nostr?: import('nostr-tools/nip07').WindowNostr }

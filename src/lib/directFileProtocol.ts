import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools'

export const DIRECT_FILE_PREFIX = 'iris-direct-file-v1:'
export const DIRECT_FILE_KIND = 21111
export const MAX_DIRECT_FILES = 32
export const MAX_DIRECT_FILE_BYTES = 100 * 1024 * 1024 * 1024
const encoder = new TextEncoder()

/** This signed payload is shared with iris-chat-rs. Keep its wire field names. */
export interface DirectFileOffer {
  id: string
  token: string
  owner: string
  recipient: string
  device: string
  caption: string
  expires_at_secs: number
  files: { filename: string; size_bytes: number; sha256: string }[]
}

const parsed = new Map<string, DirectFileOffer | undefined>()
const hex = (value: unknown, length: number): value is string =>
  typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value)

export function safeDirectFilename(name: string): boolean {
  return !!name && encoder.encode(name).length <= 240 && name !== '.' && name !== '..' &&
    !/[\p{Cc}/\\<>:"|?*]/u.test(name)
}

export function parseDirectFileOffer(body: string): DirectFileOffer | undefined {
  if (!body.startsWith(DIRECT_FILE_PREFIX)) return
  if (parsed.has(body)) return parsed.get(body)
  if (encoder.encode(body.slice(DIRECT_FILE_PREFIX.length)).length > 32 * 1024) return
  let offer: DirectFileOffer | undefined
  try {
    const event = JSON.parse(body.slice(DIRECT_FILE_PREFIX.length))
    if (event.kind !== DIRECT_FILE_KIND || !Number.isSafeInteger(event.created_at) ||
      event.created_at < 0 || !verifyEvent(event)) return
    const value = JSON.parse(event.content)
    if (!value || value.device !== event.pubkey || !hex(value.id, 32) || !hex(value.token, 64) ||
      !hex(value.owner, 64) || !hex(value.recipient, 64) || !hex(value.device, 64) ||
      typeof value.caption !== 'string' || encoder.encode(value.caption).length > 4096 ||
      !Number.isSafeInteger(value.expires_at_secs) || value.expires_at_secs <= event.created_at ||
      value.expires_at_secs > event.created_at + 24 * 60 * 60 ||
      !Array.isArray(value.files) || !value.files.length || value.files.length > MAX_DIRECT_FILES ||
      value.files.some((file: DirectFileOffer['files'][number]) => !file ||
        typeof file.filename !== 'string' || !safeDirectFilename(file.filename) ||
        !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0 ||
        file.size_bytes > MAX_DIRECT_FILE_BYTES || !hex(file.sha256, 64))) return
    offer = value as DirectFileOffer
    for (const file of offer.files) Object.freeze(file)
    Object.freeze(offer.files)
    Object.freeze(offer)
  } catch { /* Ordinary messages and invalid signatures are not file offers. */ }
  if (parsed.size >= 128) parsed.delete(parsed.keys().next().value!)
  parsed.set(body, offer)
  return offer
}

export function signDirectFileOffer(offer: DirectFileOffer, secret: Uint8Array): string {
  if (getPublicKey(secret) !== offer.device) throw new Error('The sending device has changed. Try again.')
  const event = finalizeEvent({ kind: DIRECT_FILE_KIND, created_at: Math.floor(Date.now() / 1000),
    tags: [], content: JSON.stringify(offer) }, secret)
  const wire = DIRECT_FILE_PREFIX + JSON.stringify(event)
  if (encoder.encode(wire).length > 32 * 1024 || !parseDirectFileOffer(wire)) {
    throw new Error('The file offer is too large or contains an unsupported file name.')
  }
  return wire
}

export function directFileMessageFields(content: string): { directTransferId?: string } {
  const offer = parseDirectFileOffer(content)
  return offer ? { directTransferId: offer.id } : {}
}

export function directFilePreview(content: string): string {
  const offer = parseDirectFileOffer(content)
  return offer ? offer.caption || 'Direct files' : content
}

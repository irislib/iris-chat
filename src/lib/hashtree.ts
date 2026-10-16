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
import { writable } from 'svelte/store'
import { AttachmentStore } from './attachmentStore'
import { AttachmentReplication } from './attachmentReplication'
import { TcpBlobTransport } from '@hashtree/fips-transport'
import type { FipsDatagramEndpoint } from '@fips/tcp'
import { normalizeDeviceSyncPeer } from './deviceSyncTcp'
import { attachmentEndpoint } from './attachmentEndpoint'
import { getPubkey, getPrivkeyBytes, isNip07Login, isLinkedDeviceLogin } from './identity'
import { finalizeEvent } from 'nostr-tools'

// Default Blossom servers
const DEFAULT_BLOSSOM_SERVERS = [
  { url: 'https://upload.iris.to', write: true, read: false },
  { url: 'https://cdn.iris.to', write: false, read: true },
]

// Only encrypted attachment blocks enter this bounded store, never private event indexes.
let attachmentCache: AttachmentStore | undefined
let attachmentPeers: TcpBlobTransport | undefined
let attachmentPeerCleanup: (() => Promise<void>) | undefined
let peerIds: () => readonly string[] = () => []
let activeAccount: { owner: string; replication: AttachmentReplication } | undefined
const activeWrites = new Set<string>()
const stagedWrites = new Set<string>()
let draftHeartbeat: ReturnType<typeof setInterval> | undefined
function stopStaging(id: string) {
  stagedWrites.delete(id)
  if (!stagedWrites.size) { clearInterval(draftHeartbeat); draftHeartbeat = undefined }
}
function trackStaging(id: string) {
  stagedWrites.add(id)
  draftHeartbeat ??= setInterval(() => {
    for (const pending of stagedWrites) void getAttachmentCache().renewDraft(pending).catch(() => {})
  }, 20_000)
}
let pendingStarts = 0
export const attachmentUploadsVersion = writable(0)
const uploadsChanged = () => attachmentUploadsVersion.update(value => value + 1)
export const getAttachmentCache = (): AttachmentStore => attachmentCache ??= new AttachmentStore()
export function setAttachmentAccount(owner: string | null) {
  if (activeAccount?.owner === owner) return
  activeAccount?.replication.stop(); activeAccount = undefined
  for (const id of activeWrites) void getAttachmentCache().abort(id).catch(() => {})
  activeWrites.clear()
  for (const id of stagedWrites) void getAttachmentCache().abort(id, true).catch(() => {})
  stagedWrites.clear(); clearInterval(draftHeartbeat); draftHeartbeat = undefined
  void deactivateAttachmentPeers()
  if (owner) {
    const account = { owner, replication: undefined as unknown as AttachmentReplication }
    const current = () => activeAccount === account && getPubkey() === owner
    account.replication = new AttachmentReplication(getAttachmentCache(), owner, async event => {
      if (!current()) throw new Error('Account changed')
      const signed = await createSigner()(event)
      if (!current()) throw new Error('Account changed')
      return signed
    }, current, uploadsChanged)
    activeAccount = account; account.replication.wake()
  }
  uploadsChanged()
}
/** Register inbound service before discovery; publish the client only after startup succeeds. */
export function prepareAttachmentPeers(node: FipsDatagramEndpoint, peers: () => readonly string[], allow: (peer: string) => boolean) {
  const transport = attachmentEndpoint(node)
  const tcp = new TcpBlobTransport({ endpoint: transport.endpoint, localStore: getAttachmentCache(), allowIncomingPeer: allow })
  let closed = false
  const dispose = async () => {
    if (closed) return
    closed = true; transport.close()
    if (attachmentPeers === tcp) { attachmentPeers = undefined; peerIds = () => []; attachmentPeerCleanup = undefined }
    await tcp.close()
  }
  return {
    activate() {
      if (closed) throw new Error('Attachment transport closed')
      void deactivateAttachmentPeers()
      peerIds = () => peers().map(normalizeDeviceSyncPeer)
      attachmentPeers = tcp; attachmentPeerCleanup = dispose
    },
    dispose,
  }
}
export function activateAttachmentPeers(node: FipsDatagramEndpoint, peers: () => readonly string[], allow: (peer: string) => boolean) {
  prepareAttachmentPeers(node, peers, allow).activate()
}
export async function deactivateAttachmentPeers() {
  const cleanup = attachmentPeerCleanup
  attachmentPeers = undefined; peerIds = () => []; attachmentPeerCleanup = undefined
  await cleanup?.()
}

/**
 * Create a Nostr signer for Blossom NIP-98 auth
 */
export function createSigner(): BlossomSigner {
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

    if (isLinkedDeviceLogin() && event.kind === 24242) {
      const owner = getPubkey()
      const { getDelegateManager } = await import('./privateChats')
      if (!owner || getPubkey() !== owner || !isLinkedDeviceLogin()) throw new Error('Account changed')
      // Blossom authenticates the blob upload, not an owner profile statement.
      // A linked device signs with its own existing key; owner authority stays private.
      return finalizeEvent(event, getDelegateManager().getIdentityKey())
    }

    throw new Error('No signer available')
  }
}

function currentAccount() {
  const owner = getPubkey()
  if (!owner) throw new Error('Not logged in')
  setAttachmentAccount(owner)
  return activeAccount!
}
function getHashTree(readId: string): HashTree {
  const account = currentAccount(), cache = getAttachmentCache()
  const blossom = new BlossomStore({ servers: DEFAULT_BLOSSOM_SERVERS, getTimeoutMs: 15_000 })
  return new HashTree({ store: {
    async get(hash) {
      if (activeAccount !== account) throw new Error('Account changed')
      const cached = await cache.get(hash)
      if (cached) { await cache.writer(readId).put(hash, cached); return cached }
      const peers = peerIds()
      const data = (peers.length ? await attachmentPeers?.get(hash, peers).catch(() => null) : null) ?? await blossom.get(hash)
      if (activeAccount !== account) throw new Error('Account changed')
      // Read-through caching is best effort. A full protected cache must not break a download.
      if (data) await cache.writer(readId).put(hash, data).catch(() => {})
      return data
    },
    put: (hash, data) => cache.put(hash, data),
    has: hash => cache.has(hash), delete: hash => cache.delete(hash),
  } })
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
  onProgress?: UploadProgressCallback,
  options: { requireRemote?: boolean; staged?: boolean } = {},
): Promise<{ nhash: string; filename: string; discard: () => void; retain: () => Promise<void> }> {
  const account = currentAccount(), cache = getAttachmentCache()
  if (activeWrites.size + pendingStarts >= 2) throw new Error('Wait for the other attachments to finish')
  if (file.size > cache.limit) throw new Error('This file exceeds attachment storage capacity')
  pendingStarts++
  let id: string
  try { id = await cache.begin(account.owner, DEFAULT_BLOSSOM_SERVERS.filter(server => server.write).map(server => server.url)) }
  finally { pendingStarts-- }
  activeWrites.add(id)
  const reader = file.stream().getReader()
  try {
    const stream = new HashTree({ store: cache.writer(id) }).createStream({ unencrypted: false })
    let bytesRead = 0
    while (true) {
      if (activeAccount !== account || getPubkey() !== account.owner) throw new Error('Account changed')
      const { done, value } = await reader.read()
      if (done) break
      await stream.append(value); bytesRead += value.length; onProgress?.(bytesRead, file.size)
    }
    const result = await stream.finalize()
    if (!result.key) throw new Error('Attachment encryption failed')
    if (activeAccount !== account || getPubkey() !== account.owner) throw new Error('Account changed')
    const nhash = nhashEncode({ hash: result.hash, key: result.key })
    await cache.finish(id, nhash, result.hash, options.staged)
    if (activeAccount !== account || getPubkey() !== account.owner) throw new Error('Account changed')
    if (options.staged) trackStaging(id)
    account.replication.wake(); uploadsChanged()
    if (options.requireRemote) {
      const deadline = Date.now() + 30_000
      let confirmed = false
      while (Date.now() < deadline) {
        if (activeAccount !== account) throw new Error('Account changed')
        const receipts = await cache.receipts(account.owner, [nhash])
        if (receipts.some(row => row.uploadedUrls.length)) { confirmed = true; break }
        if (Date.now() + 100 >= deadline) throw new Error('Could not upload this image. Try again.')
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (!confirmed) throw new Error('Could not upload this image. Try again.')
    }
    if (activeAccount !== account || getPubkey() !== account.owner) throw new Error('Account changed')
    return { nhash, filename: file.name,
      discard: () => { stopStaging(id); void cache.abort(id, true).then(uploadsChanged).catch(() => {}) },
      retain: async () => {
        if (activeAccount !== account) throw new Error('Account changed')
        await cache.retain(id)
        if (activeAccount !== account) throw new Error('Account changed')
        stopStaging(id)
      },
    }
  } catch (error) {
    stopStaging(id)
    await cache.abort(id, true).catch(() => {})
    throw error
  } finally {
    activeWrites.delete(id); await reader.cancel().catch(() => {})
  }
}

export async function attachmentUploadInfo(content: string) {
  const owner = getPubkey()
  if (!owner) return []
  const files = [...content.matchAll(new RegExp(FILE_LINK_REGEX.source, 'gi'))].flatMap(match => {
    try { nhashDecode(match[1]!); return [{ nhash: match[1]!, filename: decodeURIComponent(match[2]!) }] } catch { return [] }
  }).slice(0, 64)
  const receipts = await getAttachmentCache().receipts(owner, files.map(file => file.nhash))
  if (getPubkey() !== owner) return []
  return files.map(file => ({ filename: file.filename, uploadedUrls: [...new Set(receipts.filter(row => row.nhash === file.nhash).flatMap(row => row.uploadedUrls))] }))
}

/**
 * Download and decrypt a file from nhash
 */
export async function downloadFile(nhash: string): Promise<Uint8Array> {
  const account = currentAccount(), cache = getAttachmentCache()
  const id = await cache.begin(account.owner, DEFAULT_BLOSSOM_SERVERS.filter(server => server.write).map(server => server.url), true)
  try {
    const data = await getHashTree(id).readFile(nhashDecode(nhash))
    if (!data) throw new Error('File not found')
    if (activeAccount !== account) throw new Error('Account changed')
    return data
  } finally { await cache.abort(id) }
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
 * Parse a file link: nhash/filename, htree://nhash/filename, or nhash://nhash/filename
 */
export function parseFileLink(link: string): { nhash: string; filename: string } | null {
  const cleaned = link.replace(/^(?:htree|nhash):\/\//, '')

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

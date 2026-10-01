import { get, writable } from 'svelte/store'
import type { FipsDatagramEndpoint } from '@fips/tcp'
import { sha256 } from '@noble/hashes/sha2.js'
import { getPublicKey } from 'nostr-tools'
import { chats, sendMessage, type ChatSession } from './chat'
import { getPubkey } from './identity'
import { devices } from './devices'
import { getNdrRuntime, preparePeerNdrRuntime } from './privateChats'
import { getMessageRequestPolicyContext, isChatRejected } from './messageRequestPolicy'
import { acceptChat } from './messageRequests'
import { getSessionManagerValue, putSessionManagerValue } from './storage'
import { DirectFileTcp, type DirectFileSpec, type DirectFileSource } from './directFileTcp'
import { DirectFileStorage } from './directFileStorage'
import { MAX_DIRECT_FILES, MAX_DIRECT_FILE_BYTES, parseDirectFileOffer, safeDirectFilename,
  signDirectFileOffer, type DirectFileOffer } from './directFileProtocol'

export type DirectFileStatus = 'offered' | 'connecting' | 'transferring' | 'completed' |
  'declined' | 'cancelled' | 'failed' | 'unavailable'
export interface DirectFileTransfer {
  id: string
  files: { filename: string; sizeBytes: number }[]
  status: DirectFileStatus
  isSender: boolean
  transferredBytes: number
  totalBytes: number
  error?: string
}
interface TransferRecord extends DirectFileTransfer {
  wire: string
  chatId: string
  offer: DirectFileOffer
  blobs?: Blob[]
}
interface Runtime {
  owner: string
  device: string
  secret: Uint8Array
  tcp: DirectFileTcp
  storage: DirectFileStorage
  connect: (device: string) => Promise<void>
}

export const directFileTransfers = writable<Map<string, DirectFileTransfer>>(new Map())
const records = new Map<string, TransferRecord>()
const loading = new Set<string>()
const objectUrls = new Set<string>()
const pendingSends = new Set<Promise<void>>()
let active: Runtime | undefined
let generation = 0
let unsubscribe: (() => void) | undefined
let refreshTimer: ReturnType<typeof setInterval> | undefined
let pendingWrites = Promise.resolve()
const isActive = (status: DirectFileStatus) => ['offered', 'connecting', 'transferring'].includes(status)
const now = () => Math.floor(Date.now() / 1000)
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
const specs = (offer: DirectFileOffer): DirectFileSpec[] => offer.files.map(file => ({
  filename: file.filename, sizeBytes: file.size_bytes, sha256: file.sha256,
}))
const key = (runtime: Runtime, id: string) => `v1/direct-files/${runtime.owner}/${runtime.device}/${id}`

function transferError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/no route|connection|timed out|timeout|unreachable/i.test(message)) return 'Couldn’t reach the other device. Keep both apps open.'
  if (/quota|space|not saved completely/i.test(message)) return 'There isn’t enough space to save these files.'
  if (/authorization|not available to this device/i.test(message)) return 'The other device is no longer available.'
  if (/did not match|hash|checksum/i.test(message)) return 'These files could not be verified. Please send them again.'
  if (message.startsWith('This browser cannot receive files directly.')) return message
  return 'Couldn’t transfer these files. Please send them again.'
}

function publish(record: TransferRecord, persist = true, runtime = active): void {
  records.set(record.id, record)
  const { wire: _wire, chatId: _chatId, offer: _offer, blobs: _blobs, ...snapshot } = record
  directFileTransfers.update(all => new Map(all).set(record.id, snapshot))
  if (persist && runtime) {
    pendingWrites = pendingWrites.then(() => putSessionManagerValue(key(runtime, record.id),
      { ...snapshot, wire: record.wire, chatId: record.chatId }))
      .catch(() => { /* The live transfer remains usable if local history storage is full. */ })
  }
}

export function knownDirectFileDevices(owner: string): string[] {
  try {
    const roster = owner === getPubkey() ? get(devices).registeredDevices :
      getNdrRuntime().getKnownAppKeysSnapshots().find(snapshot => snapshot.ownerPubkey === owner)?.appKeys.getAllDevices()
    return [...new Set((roster ?? []).map(device => device.identityPubkey.toLowerCase()))]
      .filter(device => /^[0-9a-f]{64}$/.test(device))
  } catch { return [] }
}

function receiverAllowed(runtime: Runtime, offer: DirectFileOffer): boolean {
  return offer.recipient === runtime.owner && offer.device !== runtime.device &&
    !isChatRejected(offer.owner, getMessageRequestPolicyContext()) &&
    knownDirectFileDevices(offer.owner).includes(offer.device)
}

async function ingest(runtime: Runtime, chat: ChatSession, wire: string, isMine: boolean): Promise<void> {
  const offer = parseDirectFileOffer(wire)
  if (!offer || offer.owner !== (isMine ? runtime.owner : chat.recipientPubkey) ||
    offer.recipient !== (isMine ? chat.recipientPubkey : runtime.owner) ||
    records.has(offer.id) || loading.has(offer.id)) return
  loading.add(offer.id)
  try {
    const previous = await getSessionManagerValue<DirectFileTransfer & { wire: string }>(key(runtime, offer.id))
    if (active !== runtime) return
    const isSender = offer.device === runtime.device
    let status: DirectFileStatus = isSender || offer.recipient !== runtime.owner || offer.expires_at_secs <= now()
      ? 'unavailable' : 'offered'
    if (previous?.wire === wire) {
      status = isActive(previous.status)
        ? previous.status === 'offered' && !isSender ? status : 'unavailable'
        : previous.status
      if (isSender && status === 'completed') status = 'unavailable'
    }
    publish({ id: offer.id, wire, chatId: chat.id, offer, files: specs(offer), isSender, status,
      transferredBytes: previous?.wire === wire ? previous.transferredBytes : 0,
      totalBytes: offer.files.reduce((sum, file) => sum + file.size_bytes, 0),
      ...(previous?.wire === wire && previous.error ? { error: previous.error } : {}),
    })
  } finally { if (active === runtime) loading.delete(offer.id) }
}

function refreshAuthorization(): void {
  const runtime = active
  if (!runtime) return
  for (const record of records.values()) {
    if (!isActive(record.status)) continue
    if (!get(chats).has(record.chatId)) {
      publish({ ...record, status: 'cancelled', blobs: undefined })
      runtime.tcp.cancel(record.id)
    } else if (record.status === 'offered' && record.offer.expires_at_secs <= now()) {
      publish({ ...record, status: 'unavailable', blobs: undefined })
      runtime.tcp.cancel(record.id)
    } else if (record.isSender) {
      const allowed = isChatRejected(record.offer.recipient, getMessageRequestPolicyContext()) ? [] :
        knownDirectFileDevices(record.offer.recipient).filter(device => device !== runtime.device)
      runtime.tcp.restrictOffer(record.id, allowed)
    } else if (record.status !== 'offered' && !receiverAllowed(runtime, record.offer)) {
      publish({ ...record, status: 'cancelled', error: 'This device is no longer linked.' })
      runtime.tcp.cancel(record.id)
    }
  }
}

export async function attachDirectFiles(endpoint: FipsDatagramEndpoint, owner: string, secret: Uint8Array,
  connect: (device: string) => Promise<void>): Promise<void> {
  const detached = detachDirectFiles()
  const run = generation
  await detached
  if (run !== generation) return
  const device = getPublicKey(secret)
  const storage = new DirectFileStorage(owner, device)
  const tcp = new DirectFileTcp({ endpoint, localPeer: device,
    createReceiveFile: (id, index) => storage.createFile(id, index),
    onEvent: event => {
      if (run !== generation) return
      const record = records.get(event.transferId)
      if (!record || !isActive(record.status)) return
      const status: DirectFileStatus = event.type === 'accepted' ? 'connecting' :
        event.type === 'progress' ? 'transferring' : event.type
      publish({ ...record, status,
        transferredBytes: event.transferredBytes ?? record.transferredBytes,
        ...(event.type === 'completed' ? { transferredBytes: record.totalBytes } : {}),
        ...(event.files?.length ? { blobs: event.files.map(file => file.blob) } : {}),
        ...(event.error ? { error: transferError(event.error) } : {}),
        ...(!isActive(status) && status !== 'completed' ? { blobs: undefined } : {}),
      }, event.type !== 'progress')
    },
  })
  const runtime: Runtime = { owner, device, secret: new Uint8Array(secret), tcp, storage, connect }
  active = runtime
  unsubscribe = chats.subscribe(all => {
    for (const chat of all.values()) for (const message of chat.messages) {
      void ingest(runtime, chat, message.content, message.isMine).catch(() => undefined)
    }
    refreshAuthorization()
  })
  refreshTimer = setInterval(refreshAuthorization, 1000)
}

export async function detachDirectFiles(): Promise<void> {
  generation++
  unsubscribe?.(); unsubscribe = undefined
  clearInterval(refreshTimer); refreshTimer = undefined
  const previous = active
  active = undefined
  for (const record of records.values()) if (isActive(record.status)) {
    publish({ ...record, status: 'unavailable', blobs: undefined }, true, previous)
  }
  records.clear(); loading.clear(); directFileTransfers.set(new Map())
  for (const url of objectUrls) URL.revokeObjectURL(url)
  objectUrls.clear()
  await previous?.tcp.dispose().catch(() => undefined)
  await Promise.allSettled([...pendingSends])
  await pendingWrites
  previous?.secret.fill(0)
}

async function ready(chat: ChatSession): Promise<Runtime> {
  const owner = getPubkey()
  await preparePeerNdrRuntime(chat.recipientPubkey)
  const deadline = Date.now() + 10_000
  while (!active && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  if (!active || active.owner !== owner || owner !== getPubkey()) throw new Error('Still connecting. Try again shortly.')
  return active
}

export async function sendDirectFiles(chat: ChatSession, files: File[], caption = ''): Promise<void> {
  if (!files.length || files.length > MAX_DIRECT_FILES) throw new Error('Choose up to 32 files.')
  if (files.some(file => file.size > MAX_DIRECT_FILE_BYTES || !safeDirectFilename(file.name))) {
    throw new Error('A file is too large or has an unsupported name.')
  }
  if (!get(chats).has(chat.id) || isChatRejected(chat.recipientPubkey, getMessageRequestPolicyContext())) {
    throw new Error('This chat is unavailable.')
  }
  const runtime = await ready(chat)
  const allowed = knownDirectFileDevices(chat.recipientPubkey).filter(device => device !== runtime.device)
  if (!allowed.length) throw new Error(chat.recipientPubkey === runtime.owner ? 'Link another device first.' : 'No receiving device is available yet.')
  const sources: DirectFileSource[] = []
  for (const file of files) {
    const hash = sha256.create()
    for (let offset = 0; offset < file.size; offset += 64 * 1024) {
      hash.update(new Uint8Array(await file.slice(offset, offset + 64 * 1024).arrayBuffer()))
      if (active !== runtime) throw new Error('The sending device has changed. Try again.')
    }
    sources.push({ filename: file.name, sizeBytes: file.size, sha256: hex(hash.digest()), blob: file })
  }
  if (active !== runtime) throw new Error('The sending device has changed. Try again.')
  const offer: DirectFileOffer = { id: hex(crypto.getRandomValues(new Uint8Array(16))),
    token: hex(crypto.getRandomValues(new Uint8Array(32))), owner: runtime.owner,
    recipient: chat.recipientPubkey, device: runtime.device, caption, expires_at_secs: now() + 24 * 60 * 60,
    files: sources.map(file => ({ filename: file.filename, size_bytes: file.sizeBytes, sha256: file.sha256 })),
  }
  const wire = signDirectFileOffer(offer, runtime.secret)
  const record: TransferRecord = { id: offer.id, wire, offer, chatId: chat.id, files: specs(offer),
    isSender: true, status: 'offered', transferredBytes: 0,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0), blobs: files,
  }
  runtime.tcp.registerOffer(offer.id, offer.token, allowed, sources)
  publish(record)
  const sending = sendMessage(chat, wire, undefined, () => active === runtime)
  pendingSends.add(sending)
  try {
    await sending
    if (active !== runtime) throw new Error('The sending device has changed. Try again.')
    if (!get(chats).get(chat.id)?.messages.some(message => message.content === wire)) throw new Error('This chat is unavailable.')
    void Promise.allSettled(allowed.map(device => runtime.connect(device)))
  } catch (error) {
    if (active === runtime) publish({ ...record, status: 'failed', error: 'Could not offer these files.', blobs: undefined })
    runtime.tcp.cancel(offer.id)
    throw error
  } finally { pendingSends.delete(sending) }
}

async function incoming(id: string): Promise<{ runtime: Runtime; record: TransferRecord }> {
  const record = records.get(id)
  const chat = record && get(chats).get(record.chatId)
  if (!record || !chat || record.status !== 'offered' || record.isSender) throw new Error('These files are unavailable.')
  const runtime = await ready(chat)
  if (records.get(id) !== record || record.offer.expires_at_secs <= now() || !receiverAllowed(runtime, record.offer)) {
    throw new Error('The sending device is no longer available.')
  }
  return { runtime, record }
}

export async function acceptDirectFiles(id: string): Promise<void> {
  const { runtime, record } = await incoming(id)
  if (active !== runtime || records.get(id) !== record || record.status !== 'offered') throw new Error('This offer has already been handled.')
  publish({ ...record, status: 'connecting', error: undefined })
  acceptChat(record.chatId)
  try {
    await runtime.connect(record.offer.device).catch(() => undefined)
    if (active !== runtime || records.get(id)?.status !== 'connecting') return
    await runtime.tcp.receive(id, record.offer.token, record.offer.device, specs(record.offer))
  } catch (error) {
    const current = records.get(id)
    if (active === runtime && current && isActive(current.status)) publish({ ...current, status: 'failed',
      error: transferError(error) })
    throw new Error(transferError(error))
  }
}

export async function declineDirectFiles(id: string): Promise<void> {
  const { runtime, record } = await incoming(id)
  if (active !== runtime || records.get(id) !== record || record.status !== 'offered') throw new Error('This offer has already been handled.')
  publish({ ...record, status: 'declined' })
  await runtime.connect(record.offer.device).catch(() => undefined)
  if (active === runtime) {
    try { await runtime.tcp.decline(id, record.offer.token, record.offer.device) }
    catch (error) { throw new Error(transferError(error)) }
  }
}

export async function cancelDirectFiles(id: string): Promise<void> {
  const record = records.get(id)
  if (!record || !isActive(record.status)) return
  publish({ ...record, status: 'cancelled', blobs: undefined })
  active?.tcp.cancel(id)
}

export async function downloadDirectFile(id: string, index: number): Promise<void> {
  const runtime = active
  const record = records.get(id)
  const file = record?.offer.files[index]
  if (!runtime || !record || record.status !== 'completed' || !file) throw new Error('This file is unavailable.')
  const blob = record.blobs?.[index] ?? (!record.isSender ? await runtime.storage.getFile(id, index) : undefined)
  if (active !== runtime || records.get(id) !== record) throw new Error('This file is no longer available.')
  if (!blob || blob.size !== file.size_bytes) throw new Error('This file is no longer on this device.')
  const url = URL.createObjectURL(blob)
  objectUrls.add(url)
  const link = document.createElement('a')
  link.href = url; link.download = file.filename; link.click()
  setTimeout(() => { URL.revokeObjectURL(url); objectUrls.delete(url) }, 60_000)
}

export const DEVICE_SYNC_PORT = 7369
export const DEVICE_SYNC_MAX_PACKET_BYTES = 64 * 1024
export const DEVICE_SYNC_PAGE_MESSAGES = 32
export const DEVICE_SYNC_PAGE_PACKETS = 32

export interface DeviceSyncChat {
  id: string
  updatedAt: number
}

export interface DeviceSyncAppKeys {
  ownerPubkey: string
  createdAt: number
  devices: Array<{ identityPubkey: string; createdAt: number }>
}

export interface DeviceSyncGroup {
  id: string
  name: string
  description?: string
  picture?: string
  createdBy: string
  members: string[]
  admins: string[]
  revision: number
  createdAt: number
  updatedAt: number
  accepted?: boolean
  protocol?: 'sender_key_v1' | 'pairwise_fanout_v1'
}

export interface DeviceSyncMessage {
  chatId: string
  id: string
  body: string
  author: string
  createdAt: number
  expiresAt?: number
}

export interface DeviceSyncCursor {
  createdAt: number
  chatId: string
  id: string
}

export type DeviceSyncPage =
  | { kind: 'metadata'; offset: number }
  | { kind: 'messages'; after: DeviceSyncCursor | null }

export interface DeviceSyncRequest {
  v: 1
  type: 'request'
  rosterAt: number
  page?: DeviceSyncPage
}

export interface DeviceSyncResyncRequired {
  v: 1
  type: 'resyncRequired'
}

export interface DeviceSyncPageEnd {
  v: 1
  type: 'pageEnd'
  rosterAt: number
  next: DeviceSyncPage
}

export interface DeviceSyncSnapshot {
  v: 1
  type: 'snapshot'
  rosterAt: number
  appKeys: DeviceSyncAppKeys[]
  chats: DeviceSyncChat[]
  groups: DeviceSyncGroup[]
  messages: DeviceSyncMessage[]
}

export type DeviceSyncPacket =
  | DeviceSyncRequest
  | DeviceSyncResyncRequired
  | DeviceSyncPageEnd
  | DeviceSyncSnapshot

export class DeviceSyncProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`invalid device sync packet: ${message}`, options)
    this.name = 'DeviceSyncProtocolError'
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function encodeDeviceSyncPacket(packet: DeviceSyncPacket): Uint8Array {
  const bytes = serializedPacket(packet)
  if (bytes.byteLength > DEVICE_SYNC_MAX_PACKET_BYTES) {
    throw new DeviceSyncProtocolError('record exceeds 64 KiB')
  }
  return bytes
}

export function deviceSyncPacketByteLength(packet: DeviceSyncPacket): number {
  return serializedPacket(packet).byteLength
}

function serializedPacket(packet: DeviceSyncPacket): Uint8Array {
  const wire = packet.type === 'snapshot'
    ? {
        ...packet,
        messages: packet.messages.map((message) => ({
          ...message,
          body: encodeBase64(encoder.encode(message.body)),
        })),
      }
    : packet
  return encoder.encode(JSON.stringify(wire))
}

export function parseDeviceSyncPacket(
  payload: Uint8Array,
  ownerPubkey: string,
): DeviceSyncPacket {
  if (payload.byteLength > DEVICE_SYNC_MAX_PACKET_BYTES) fail('record exceeds 64 KiB')

  let value: unknown
  try {
    value = JSON.parse(decoder.decode(payload))
  } catch (error) {
    throw new DeviceSyncProtocolError('record is not valid UTF-8 JSON', { cause: error })
  }
  if (!isObject(value) || value.v !== 1 || typeof value.type !== 'string') {
    fail('version or packet type is unsupported')
  }

  switch (value.type) {
    case 'request':
      if (!isTime(value.rosterAt)) fail('request rosterAt is invalid')
      return {
        v: 1,
        type: 'request',
        rosterAt: value.rosterAt,
        ...(value.page !== undefined && value.page !== null && { page: parsePage(value.page) }),
      }
    case 'resyncRequired':
      return { v: 1, type: 'resyncRequired' }
    case 'pageEnd':
      if (!isTime(value.rosterAt)) fail('pageEnd rosterAt is invalid')
      return { v: 1, type: 'pageEnd', rosterAt: value.rosterAt, next: parsePage(value.next) }
    case 'snapshot':
      return parseSnapshot(value, ownerPubkey)
    default:
      fail(`unknown packet type ${value.type}`)
  }
}

function parsePage(value: unknown): DeviceSyncPage {
  if (!isObject(value)) fail('page is not an object')
  if (value.kind === 'metadata') {
    if (!isTime(value.offset)) fail('metadata offset is invalid')
    return { kind: 'metadata', offset: value.offset }
  }
  if (value.kind === 'messages') {
    if (value.after === undefined || value.after === null) {
      return { kind: 'messages', after: null }
    }
    if (
      !isObject(value.after) ||
      !isTime(value.after.createdAt) ||
      !validChatId(value.after.chatId) ||
      !isId(value.after.id, 128)
    ) fail('message cursor is invalid')
    return {
      kind: 'messages',
      after: {
        createdAt: value.after.createdAt,
        chatId: value.after.chatId,
        id: value.after.id,
      },
    }
  }
  fail('page kind is unsupported')
}

function parseSnapshot(value: Record<string, unknown>, ownerPubkey: string): DeviceSyncSnapshot {
  if (!isTime(value.rosterAt)) fail('snapshot rosterAt is invalid')
  const appKeys = defaultArray(value.appKeys, 'appKeys')
  const chats = defaultArray(value.chats, 'chats')
  const groups = defaultArray(value.groups, 'groups')
  const messages = defaultArray(value.messages, 'messages')

  if (!appKeys.every(validAppKeys)) fail('snapshot appKeys are invalid')
  if (!chats.every(validChat)) fail('snapshot chats are invalid')
  if (!groups.every((group) => validGroup(group, ownerPubkey))) {
    fail('snapshot groups are invalid')
  }

  const decodedMessages = messages.map(parseMessage)
  return {
    v: 1,
    type: 'snapshot',
    rosterAt: value.rosterAt,
    appKeys: appKeys as unknown as DeviceSyncAppKeys[],
    chats: chats as unknown as DeviceSyncChat[],
    groups: groups as unknown as DeviceSyncGroup[],
    messages: decodedMessages,
  }
}

function validAppKeys(value: unknown): boolean {
  if (
    !isObject(value) ||
    !isPubkey(value.ownerPubkey) ||
    !isTime(value.createdAt) ||
    !Array.isArray(value.devices)
  ) return false
  const identities = new Set<string>()
  return value.devices.every((device) => {
    if (!isObject(device) || !isPubkey(device.identityPubkey) || !isTime(device.createdAt)) {
      return false
    }
    const identity = device.identityPubkey.toLowerCase()
    if (identities.has(identity)) return false
    identities.add(identity)
    return true
  })
}

function validChat(value: unknown): boolean {
  return isObject(value) && isPubkey(value.id) && isTime(value.updatedAt)
}

function validGroup(value: unknown, ownerPubkey: string): boolean {
  if (!isObject(value)) return false
  return isId(value.id, 128) &&
    typeof value.name === 'string' && value.name.length <= 4096 &&
    isPubkey(value.createdBy) &&
    Array.isArray(value.members) && value.members.length > 0 &&
    value.members.every(isPubkey) &&
    value.members.some((member) => member.toLowerCase() === ownerPubkey.toLowerCase()) &&
    Array.isArray(value.admins) && value.admins.every(isPubkey) &&
    isTime(value.revision) && isTime(value.createdAt) && isTime(value.updatedAt) &&
    (value.description === undefined || typeof value.description === 'string') &&
    (value.picture === undefined || typeof value.picture === 'string') &&
    (value.accepted === undefined || typeof value.accepted === 'boolean') &&
    (value.protocol === undefined ||
      value.protocol === 'sender_key_v1' || value.protocol === 'pairwise_fanout_v1')
}

function parseMessage(value: unknown): DeviceSyncMessage {
  if (
    !isObject(value) ||
    !validChatId(value.chatId) ||
    !isId(value.id, 128) ||
    typeof value.body !== 'string' ||
    !isPubkey(value.author) ||
    !isTime(value.createdAt) ||
    (value.expiresAt !== undefined && !isTime(value.expiresAt))
  ) fail('snapshot messages are invalid')

  let body: string
  try {
    body = decoder.decode(decodeBase64(value.body))
  } catch (error) {
    throw new DeviceSyncProtocolError('message body is not valid base64 UTF-8', { cause: error })
  }
  return {
    chatId: value.chatId,
    id: value.id,
    body,
    author: value.author,
    createdAt: value.createdAt,
    ...(value.expiresAt !== undefined && { expiresAt: value.expiresAt as number }),
  }
}

function defaultArray(value: unknown, field: string): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(`snapshot ${field} is not an array`)
  return value
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('invalid base64')
  }
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function validChatId(value: unknown): value is string {
  return isPubkey(value) ||
    (typeof value === 'string' && value.startsWith('group:') && isId(value.slice(6), 128))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPubkey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
}

function isId(value: unknown, max: number): value is string {
  return typeof value === 'string' &&
    value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value)
}

function isTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function fail(message: string): never {
  throw new DeviceSyncProtocolError(message)
}

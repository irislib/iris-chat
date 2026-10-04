import { validPrivateDeviceLabel, type PrivateDeviceLabel } from './privateDeviceLabelProtocol'
import { validatePrivateContactDocument, type PrivateContactDocument } from 'nostr-social-graph/privateContactSyncV2'
import { isChatPinState, type ChatPinState } from './chatPinSync'
import { isChatMuteState, type ChatMuteState } from './chatMuteSync'
import { parseDeviceSyncRecord, type DeviceSyncRecord, type DeviceSyncScope } from './deviceSyncRecords'
export const DEVICE_SYNC_PORT = 7369
export const DEVICE_SYNC_MAX_PACKET_BYTES = 64 * 1024
export const DEVICE_SYNC_RECORD_BATCH = 32
export const DEVICE_SYNC_PAGE_PACKETS = 32

export interface DeviceSyncChat {
  id: string
  updatedAt: number
}

export interface DeviceSyncAppKeys {
  ownerPubkey: string
  createdAt: number
  devices: Array<{ identityPubkey: string; createdAt: number; deviceLabel?: string; clientLabel?: string; labelUpdatedAt?: number }>
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
  legacyMessageTtlSeconds?: number | null
}

export interface DeviceSyncMessage {
  chatId: string
  id: string
  body: string
  author: string
  createdAt: number
  expiresAt?: number
  legacyReactions?: Array<{ author: string; emoji: string }>
}

export type DeviceSyncPage = { kind: 'metadata'; offset: number }

export interface DeviceSyncRequest {
  v: 1
  type: 'request'
  rosterAt: number
  page?: DeviceSyncPage
  recordReconcile?: 1
  historySince?: number
}

export interface DeviceSyncResyncRequired {
  v: 1
  type: 'resyncRequired'
}

export interface DeviceSyncPageEnd {
  v: 1
  type: 'pageEnd'
  rosterAt: number
  next: DeviceSyncPage | null
  recordReconcile?: 1
  historySince?: number
}

export type DeviceHistoryPacket =
  | { v: 1; type: 'historyOpen'; messageMutations?: 1; session: string; linkId?: string; scope: DeviceSyncScope; prefix?: string; since: number; until: number; frame: string }
  | { v: 1; type: 'historyFrame'; session: string; frame: string }
  | { v: 1; type: 'historyNeed'; session: string; ids: string[] }
  | { v: 1; type: 'historyRecords'; session: string; records: DeviceSyncRecord[]; requested: string[] }
  | { v: 1; type: 'historyDone'; session: string }
  | { v: 1; type: 'historyOverflow'; session: string }

export interface DeviceSyncSnapshot {
  v: 1
  type: 'snapshot'
  rosterAt: number
  appKeys: DeviceSyncAppKeys[]
  chats: DeviceSyncChat[]
  chatMutes?: ChatMuteState[]
  chatPins?: ChatPinState[]
  privateContactsV2?: PrivateContactDocument[]
  privateDeviceLabelsV2?: PrivateDeviceLabel[]
  groups: DeviceSyncGroup[]
  messages: DeviceSyncMessage[]
}

export type DeviceHistoryPolicyPacket =
  | { v: 1; type: 'historyPolicy'; linkAt: number; linkId: string; since: number }
  | { v: 1; type: 'historyComplete'; linkAt: number; linkId: string }

export type DeviceSyncPacket =
  | DeviceHistoryPolicyPacket
  | DeviceHistoryPacket
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
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

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
    : packet.type === 'historyRecords' ? { ...packet, records: packet.records.map(record => record.type === 'message'
      ? { ...record, message: { ...record.message, body: encodeBase64(encoder.encode(record.message.body)) } } : record) } : packet
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
        ...parseHistoryCapability(value),
      }
    case 'resyncRequired':
      return { v: 1, type: 'resyncRequired' }
    case 'pageEnd':
      if (!isTime(value.rosterAt)) fail('pageEnd rosterAt is invalid')
      return { v: 1, type: 'pageEnd', rosterAt: value.rosterAt, next: value.next == null ? null : parsePage(value.next), ...parseHistoryCapability(value) }
    case 'historyPolicy':
      if (!isHistoryLinkId(value.linkId) || !isTime(value.linkAt) || !isTime(value.since) || (value.since !== 0 && value.since !== value.linkAt)) fail('history policy is invalid')
      return { v: 1, type: 'historyPolicy', linkAt: value.linkAt, linkId: value.linkId, since: value.since }
    case 'historyComplete':
      if (!isHistoryLinkId(value.linkId) || !isTime(value.linkAt)) fail('history completion is invalid')
      return { v: 1, type: value.type, linkAt: value.linkAt, linkId: value.linkId }
    case 'historyOpen':
    case 'historyFrame':
    case 'historyNeed':
    case 'historyRecords':
    case 'historyDone':
    case 'historyOverflow':
      return parseHistoryPacket(value)
    case 'snapshot':
      return parseSnapshot(value, ownerPubkey)
    default:
      fail(`unknown packet type ${value.type}`)
  }
}

function parseHistoryCapability(value: Record<string, unknown>): { recordReconcile?: 1; historySince?: number } {
  if (value.recordReconcile !== undefined && value.recordReconcile !== 1) fail('record capability is invalid')
  if (value.historySince !== undefined && !isTime(value.historySince)) fail('history cutoff is invalid')
  return { ...(value.recordReconcile === 1 && { recordReconcile: 1 as const }),
    ...(value.historySince !== undefined && { historySince: value.historySince as number }) }
}

function isHistoryLinkId(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) }

function parseHistoryPacket(value: Record<string, unknown>): DeviceHistoryPacket {
  if (typeof value.session !== 'string' || !/^[0-9a-f]{32}$/.test(value.session)) fail('history session is invalid')
  const base = { v: 1 as const, session: value.session }
  const ids = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length > 32 || !value.every(id => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id)) || new Set(value).size !== value.length) fail('history IDs are invalid')
    return value
  }
  if (value.type === 'historyNeed') return { ...base, type: value.type, ids: ids(value.ids) }
  if (value.type === 'historyRecords') {
    if (!Array.isArray(value.records) || value.records.length > 32) fail('history records are invalid')
    try { return { ...base, type: value.type, records: value.records.map(record => parseDeviceSyncRecord(record, { message: parseMessage, group: validGroup })), requested: ids(value.requested) } }
    catch { fail('history records are invalid') }
  }
  if (value.type === 'historyDone' || value.type === 'historyOverflow') return { ...base, type: value.type }
  if (typeof value.frame !== 'string' || value.frame.length > 32768 || !/^([0-9a-f]{2})+$/.test(value.frame)) fail('history frame is invalid')
  if (value.type === 'historyFrame') return { ...base, type: value.type, frame: value.frame }
  if (value.linkId !== undefined && !isHistoryLinkId(value.linkId)) fail('history link identity is invalid')
  if (!isTime(value.since) || !isTime(value.until) || value.since > value.until) fail('history window is invalid')
  if (value.scope !== 'history' && value.scope !== 'state') fail('history scope is invalid')
  if (value.scope === 'state' && (value.since !== 0 || value.until !== 0 || value.linkId !== undefined)) fail('state window is invalid')
  if (value.prefix !== undefined && (typeof value.prefix !== 'string' || !/^[0-9a-f]{0,64}$/.test(value.prefix))) fail('history prefix is invalid')
  if (value.messageMutations !== undefined && value.messageMutations !== 1) fail('message mutation capability is invalid')
  return { ...base, ...(value.messageMutations === 1 && { messageMutations: 1 as const }), ...(value.prefix !== undefined && { prefix: value.prefix as string }), ...(value.linkId !== undefined && { linkId: value.linkId as string }), scope: value.scope as DeviceSyncScope, type: 'historyOpen', since: value.since, until: value.until, frame: value.frame }
}

function parsePage(value: unknown): DeviceSyncPage {
  if (!isObject(value)) fail('page is not an object')
  if (value.kind === 'metadata') {
    if (!isTime(value.offset)) fail('metadata offset is invalid')
    return { kind: 'metadata', offset: value.offset }
  }
  fail('page kind is unsupported')
}

function parseSnapshot(value: Record<string, unknown>, owner: string): DeviceSyncSnapshot {
  if (!isTime(value.rosterAt)) fail('snapshot rosterAt is invalid')
  const privateDeviceLabelsV2 = defaultArray(value.privateDeviceLabelsV2, 'privateDeviceLabelsV2')
  if (!privateDeviceLabelsV2.every(item => validPrivateDeviceLabel(item, owner))) fail('snapshot privateDeviceLabelsV2 are invalid')
  const privateContactsV2 = defaultArray(value.privateContactsV2, 'privateContactsV2')
  try { privateContactsV2.forEach(document => validatePrivateContactDocument(document, owner)) }
  catch { fail('snapshot privateContactsV2 are invalid') }
  const appKeys = defaultArray(value.appKeys, 'appKeys')
  const chats = defaultArray(value.chats, 'chats')
  const chatPins = defaultArray(value.chatPins, 'chatPins')
  if (!chatPins.every(isChatPinState)) fail('snapshot chatPins are invalid')
  const chatMutes = defaultArray(value.chatMutes, 'chatMutes')
  if (!chatMutes.every(isChatMuteState)) fail('snapshot chatMutes are invalid')
  const groups = defaultArray(value.groups, 'groups')
  const messages = defaultArray(value.messages, 'messages')

  if (!appKeys.every(validAppKeys)) fail('snapshot appKeys are invalid')
  if (!chats.every(validChat)) fail('snapshot chats are invalid')
  if (!groups.every(validGroup)) {
    fail('snapshot groups are invalid')
  }

  const decodedMessages = messages.map(parseMessage)
  return {
    v: 1,
    type: 'snapshot',
    rosterAt: value.rosterAt,
    appKeys: appKeys as unknown as DeviceSyncAppKeys[],
    chats: chats as unknown as DeviceSyncChat[],
    ...(chatPins.length && { chatPins: chatPins as ChatPinState[] }),
    ...(privateDeviceLabelsV2.length && { privateDeviceLabelsV2: privateDeviceLabelsV2 as PrivateDeviceLabel[] }),
    ...(privateContactsV2.length && { privateContactsV2: privateContactsV2 as PrivateContactDocument[] }),
    ...(chatMutes.length && { chatMutes: chatMutes as ChatMuteState[] }),
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
    if ((device.deviceLabel !== undefined && (typeof device.deviceLabel !== 'string' || device.deviceLabel.length > 128)) ||
      (device.clientLabel !== undefined && (typeof device.clientLabel !== 'string' || device.clientLabel.length > 128)) ||
      (device.labelUpdatedAt !== undefined && !isTime(device.labelUpdatedAt))) return false
    const identity = device.identityPubkey.toLowerCase()
    if (identities.has(identity)) return false
    identities.add(identity)
    return true
  })
}

function validChat(value: unknown): boolean {
  return isObject(value) && validChatId(value.id) && isTime(value.updatedAt)
}

function validGroup(value: unknown): boolean {
  if (!isObject(value)) return false
  return isId(value.id, 128) &&
    typeof value.name === 'string' && value.name.length <= 4096 &&
    isPubkey(value.createdBy) &&
    Array.isArray(value.members) && value.members.length > 0 &&
    value.members.every(isPubkey) &&
    Array.isArray(value.admins) && value.admins.every(isPubkey) &&
    isTime(value.revision) && isTime(value.createdAt) && isTime(value.updatedAt) &&
    (value.description === undefined || typeof value.description === 'string') &&
    (value.picture === undefined || typeof value.picture === 'string') &&
    (value.accepted === undefined || typeof value.accepted === 'boolean') &&
    (value.legacyMessageTtlSeconds === undefined || value.legacyMessageTtlSeconds === null || isTime(value.legacyMessageTtlSeconds) && value.legacyMessageTtlSeconds > 0) &&
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
  if (value.legacyReactions !== undefined && (!Array.isArray(value.legacyReactions) || value.legacyReactions.length > 256 ||
    !value.legacyReactions.every(reaction => isObject(reaction) && isPubkey(reaction.author) && typeof reaction.emoji === 'string' && reaction.emoji.length > 0 && encoder.encode(reaction.emoji).length <= 256))) fail('legacy reactions are invalid')

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
    ...(value.legacyReactions !== undefined && { legacyReactions: value.legacyReactions as Array<{ author: string; emoji: string }> }),
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
  const binary = atob(value)
  if (btoa(binary) !== value) throw new Error('invalid base64')
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

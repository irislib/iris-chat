import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { verifyEvent, type Event } from 'nostr-tools'
import type { DeviceSyncGroup, DeviceSyncMessage } from './deviceSyncProtocol'

export type DeviceSyncScope = 'history' | 'state'
export interface DeviceSyncReaction {
  chatId: string
  id: string
  author: string
  createdAt: number
  createdAtMs?: number
  messageId: string
  emoji: string
}
export interface DeviceSyncGroupSettings {
  groupId: string
  id: string
  author: string
  createdAt: number
  createdAtMs?: number
  messageTtlSeconds: number | null
}
export type DeviceSyncRecord =
  | { type: 'message'; message: DeviceSyncMessage }
  | { type: 'reaction'; reaction: DeviceSyncReaction }
  | { type: 'group'; group: DeviceSyncGroup }
  | { type: 'groupSettings'; settings: DeviceSyncGroupSettings }
  | { type: 'profile'; event: Event }

export function deviceSyncRecordId(record: DeviceSyncRecord): string {
  let input: unknown[]
  switch (record.type) {
    case 'message': input = [record.message.chatId, record.message.id]; break
    case 'reaction': input = ['reaction', record.reaction.chatId, record.reaction.id]; break
    case 'groupSettings': input = ['groupSettings', record.settings.groupId, record.settings.id]; break
    case 'profile': input = ['profile', record.event.pubkey, record.event.id]; break
    case 'group': {
      const g = record.group
      input = ['group', g.id, g.revision, g.updatedAt, g.name, g.description ?? null, g.picture ?? null,
        g.createdBy, [...new Set(g.members)].sort(), [...new Set(g.admins)].sort(), g.protocol ?? 'pairwise_fanout_v1', g.createdAt]
      break
    }
  }
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(input))))
}

export function deviceSyncRecordScope(record: DeviceSyncRecord): DeviceSyncScope {
  return record.type === 'message' || record.type === 'reaction' ? 'history' : 'state'
}

export function deviceSyncRecordTime(record: DeviceSyncRecord): number {
  return record.type === 'message' ? record.message.createdAt : record.type === 'reaction' ? record.reaction.createdAt : 0
}

export function compareControlHead(a: { createdAt: number; createdAtMs?: number; id: string }, b: { createdAt: number; createdAtMs?: number; id: string }): number {
  return (a.createdAtMs ?? a.createdAt * 1000) - (b.createdAtMs ?? b.createdAt * 1000) || (a.id < b.id ? -1 : Number(a.id > b.id))
}

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const key = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128
const time = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const chat = (value: unknown): value is string => key(value) || typeof value === 'string' && value.startsWith('group:') && id(value.slice(6))
const clock = (value: Record<string, any>) => time(value.createdAt) && (value.createdAtMs === undefined ||
  time(value.createdAtMs) && Math.floor(value.createdAtMs / 1000) === value.createdAt)

export function verifiedProfileEvent(value: unknown, now = Date.now()): Event | undefined {
  if (!object(value) || value.kind !== 0 || !key(value.pubkey) || !key(value.id) || !time(value.created_at) ||
    value.created_at > now / 1000 + 300 || typeof value.content !== 'string' || value.content.length > 16384 ||
    typeof value.sig !== 'string' || !/^[a-f0-9]{128}$/.test(value.sig) || !Array.isArray(value.tags) ||
    value.tags.length > 256 || !value.tags.every((tag: unknown) => Array.isArray(tag) && tag.every(item => typeof item === 'string'))) return
  const event: Event = { id: value.id, pubkey: value.pubkey, kind: 0, created_at: value.created_at,
    tags: value.tags.map((tag: string[]) => [...tag]), content: value.content, sig: value.sig }
  try { if (!object(JSON.parse(event.content)) || !verifyEvent({ ...event })) return } catch { return }
  return event
}

export function parseDeviceSyncRecord(value: unknown, parsers: {
  message(value: unknown): DeviceSyncMessage
  group(value: unknown): boolean
}): DeviceSyncRecord {
  if (!object(value)) throw new Error('Invalid device sync record')
  if (value.type === 'message') return { type: 'message', message: parsers.message(value.message) }
  if (value.type === 'reaction') {
    const r = value.reaction
    if (object(r) && chat(r.chatId) && key(r.id) && key(r.author) && clock(r) && id(r.messageId) && typeof r.emoji === 'string' && r.emoji.length <= 64) {
      return { type: 'reaction', reaction: { chatId: r.chatId, id: r.id, author: r.author, createdAt: r.createdAt,
        ...(r.createdAtMs !== undefined && { createdAtMs: r.createdAtMs }), messageId: r.messageId, emoji: r.emoji } }
    }
  }
  if (value.type === 'group' && parsers.group(value.group)) return { type: 'group', group: value.group }
  if (value.type === 'groupSettings') {
    const s = value.settings
    if (object(s) && id(s.groupId) && key(s.id) && key(s.author) && clock(s) && (s.messageTtlSeconds === null || time(s.messageTtlSeconds) && s.messageTtlSeconds > 0)) {
      return { type: 'groupSettings', settings: { groupId: s.groupId, id: s.id, author: s.author, createdAt: s.createdAt,
        ...(s.createdAtMs !== undefined && { createdAtMs: s.createdAtMs }), messageTtlSeconds: s.messageTtlSeconds } }
    }
  }
  if (value.type === 'profile') {
    const event = verifiedProfileEvent(value.event)
    if (event) return { type: 'profile', event }
  }
  throw new Error('Invalid device sync record')
}

/** Kind 7 is plain emoji; accept the former web group JSON wrapper on ingress. */
export function reactionControl(rumor: { content: string; tags: string[][] }): { messageId: string; emoji: string } | undefined {
  const messageId = rumor.tags.find(tag => tag[0] === 'e')?.[1]
  if (!messageId) return
  let emoji = rumor.content
  if (emoji.startsWith('{')) {
    try {
      const value = JSON.parse(emoji)
      if (value?.type === 'reaction') {
        if (value.messageId !== messageId || typeof value.emoji !== 'string') return
        emoji = value.emoji
      }
    } catch { /* Plain reaction text can begin with a brace. */ }
  }
  return emoji.length <= 64 ? { messageId, emoji } : undefined
}

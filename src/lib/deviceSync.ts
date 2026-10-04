import { messageMutationFields } from './messageMutations'
import { admitRecordMessage } from './deviceSyncRecordApply'
import { createDeviceSyncRecordAdapter } from './deviceSyncRecordAdapter'
import { deviceRecordVersion, groupSettingsHead } from './deviceSyncRecordStore'
import { expirationStore } from './expirationStore'
import { getPrivateDeviceLabels, mergePrivateDeviceLabels, sendPrivateDeviceLabels, type PrivateDeviceLabel } from './privateDeviceLabels'
import type { PrivateContactDocument } from 'nostr-social-graph/privateContactSyncV2'
import { getPrivateContactDocuments, mergePrivateContacts, privateContactsVersion } from './privateContactSync'
import { requestPrivateContactSync } from './privateContactControl'
import { startChatMuteSync } from './chatMuteControl'
import { chatPinStates, loadChatPins, mergeChatPins } from './chatPinStore'
import type { ChatPinState } from './chatPinSync'
import { getCurrentDeviceRegistrationLabels, meaningfulDeviceName } from './deviceLabels'
import { chatMuteStates, loadChatMutes, mergeChatMutes } from './chatMuteStore'
import type { ChatMuteState } from './chatMuteSync'
import { get } from 'svelte/store'
import {
  FipsNode,
  fromHex,
  deriveNodeAddr,
  identityFromSecretKey,
  toHex,
  type PeerEvent,
} from '@fips/core'
import { WebRtcTransport } from '@fips/transport-webrtc'
import { WebSocketTransport } from '@fips/transport-websocket'
import { callConnectionSettings } from './callConnectionSettings'
import { AppKeys } from 'nostr-double-ratchet'
import { chats, currentChat, type ChatMessage, type ChatSession } from './chat'
import { devices, type DeviceState } from './devices'
import { getPubkey, nostrClient } from './identity'
import { AppEvent } from './nostrClient'
import { notificationSettings } from './notificationStore'
import { sendCallWakeups } from './callPush'
import { getNdrRuntime, cancelGroupPublications } from './privateChats'
import {
  groups,
  groupMessages,
  getGroupRosterVersion,
  rememberSyncedGroupRosterVersion,
  syncNativeGroupTransport,
  type Group,
  type GroupMessage,
} from './groups'
import { relayStore } from './relayStore'
import { activateNostrPubsub, deactivateNostrPubsub } from './nostrPubsubRuntime'
import { activateAttachmentPeers, deactivateAttachmentPeers } from './hashtree'
import { DeviceSyncTcp, normalizeDeviceSyncPeer } from './deviceSyncTcp'
import { DeviceHistorySync } from './deviceHistorySync'
import { closeRevokedDeviceHistoryPairs, deviceHistoryPair, deviceHistoryProgress, loadDeviceHistoryPairs, saveDeviceHistoryPair } from './deviceHistoryPolicy'
import { attachCalls, detachCalls, callOwnerForPeer, knownCallDevices } from './calls'
import { attachDirectFiles, detachDirectFiles } from './directFiles'
import { directFileMessageFields } from './directFileProtocol'
import {
  saveGroup,
  isHistoryMessageSettled,
  isHistoryChatDeleted,
  saveSession,
  type StoredGroup,
  type StoredMessage,
} from './storage'
import {
  DEVICE_SYNC_MAX_PACKET_BYTES,
  DEVICE_SYNC_RECORD_BATCH,
  DEVICE_SYNC_PAGE_PACKETS,
  DEVICE_SYNC_PORT,
  DeviceSyncProtocolError,
  deviceSyncPacketByteLength,
  encodeDeviceSyncPacket,
  parseDeviceSyncPacket,
  type DeviceSyncAppKeys,
  type DeviceSyncGroup,
  type DeviceSyncMessage,
  type DeviceSyncPacket,
  type DeviceSyncPage,
  type DeviceSyncRequest,
  type DeviceSyncSnapshot,
} from './deviceSyncProtocol'

export {
  DEVICE_SYNC_MAX_PACKET_BYTES,
  DEVICE_SYNC_RECORD_BATCH,
  DEVICE_SYNC_PAGE_PACKETS,
  DEVICE_SYNC_PORT,
  parseDeviceSyncPacket,
} from './deviceSyncProtocol'
export type {
  DeviceSyncAppKeys,
  DeviceSyncGroup,
  DeviceSyncMessage,
  DeviceSyncPacket,
  DeviceSyncPage,
  DeviceSyncRequest,
  DeviceSyncSnapshot,
} from './deviceSyncProtocol'

const DEVICE_SYNC_SCOPE = 'iris-chat-nearby-v1'

export interface DeviceSyncSnapshotSource {
  requestRosterAt: number
  localRosterAt: number
  ownerPubkey: string
  appKeys: DeviceSyncAppKeys[]
  chats: ChatSession[]
  chatMutes?: ChatMuteState[]
  chatPins?: ChatPinState[]
  privateContactsV2?: PrivateContactDocument[]
  privateDeviceLabelsV2?: PrivateDeviceLabel[]
  groups: Group[]
  groupMessages: Map<string, GroupMessage[]>
}

export interface DeviceSyncMergeState {
  rosterAt: number
  chatIds: Set<string>
  groupVersions: Map<string, { revision: number; updatedAt: number }>
  messageIds: Set<string>
}

let activeNode: FipsNode | null = null
let activeTcp: DeviceSyncTcp | null = null
let activeHistory: DeviceHistorySync | null = null
const historyPeers = new Set<string>()
let activeKey = ''
let pendingReconcile: { key: string; promise: Promise<void> } | null = null
let activeOwnerPubkey = ''
let activePeers = new Set<string>()
let deviceUnsubscribe: (() => void) | null = null
let storeUnsubscribers: Array<() => void> = []
let pushTimer: ReturnType<typeof setTimeout> | null = null
let suppressSnapshotPush = false
let generation = 0
let applyQueue: Promise<unknown> = Promise.resolve()

function applyStoreUpdate(update: () => void): void {
  suppressSnapshotPush = true
  try {
    update()
  } finally {
    suppressSnapshotPush = false
  }
}

const seconds = (timestampMs: number): number => Math.floor(timestampMs / 1000)

function normalizedXOnly(source: string): string {
  const value = source.trim().toLowerCase()
  return /^(02|03)[0-9a-f]{64}$/.test(value) ? value.slice(2) : ''
}

const isPubkey = (value: unknown): boolean =>
  typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
export function isAuthorizedDeviceSyncSource(
  source: string,
  state: DeviceState,
): boolean {
  const xOnly = normalizedXOnly(source)
  return !!(
    xOnly &&
    state.identityPubkey &&
    xOnly !== state.identityPubkey.trim().toLowerCase() &&
    state.isCurrentDeviceRegistered &&
    state.lastEventTimestamp > 0 &&
    state.registeredDevices.some(
      (device) => device.identityPubkey.trim().toLowerCase() === xOnly,
    )
  )
}

function emptySnapshot(rosterAt: number): DeviceSyncSnapshot {
  return { v: 1, type: 'snapshot', rosterAt, appKeys: [], chats: [], groups: [], messages: [] }
}

function hasSnapshotData(packet: DeviceSyncSnapshot): boolean {
  return (packet.privateDeviceLabelsV2?.length ?? 0) + (packet.privateContactsV2?.length ?? 0) + (packet.chatPins?.length ?? 0) + (packet.chatMutes?.length ?? 0) + packet.appKeys.length + packet.chats.length + packet.groups.length + packet.messages.length > 0
}

function chunkSnapshot(
  rosterAt: number,
  items: Pick<DeviceSyncSnapshot, 'appKeys' | 'chats' | 'groups' | 'messages' | 'chatMutes' | 'chatPins' | 'privateContactsV2' | 'privateDeviceLabelsV2'>,
  maxBytes: number,
): DeviceSyncSnapshot[] {
  const packets: DeviceSyncSnapshot[] = []
  let packet = emptySnapshot(rosterAt)

  const append = <K extends 'appKeys' | 'chats' | 'groups' | 'messages' | 'chatMutes' | 'chatPins' | 'privateContactsV2' | 'privateDeviceLabelsV2'>(
    key: K,
    value: NonNullable<DeviceSyncSnapshot[K]>[number],
  ) => {
    const candidate = { ...packet, [key]: [...(packet[key] ?? []), value] } as DeviceSyncSnapshot
    if (deviceSyncPacketByteLength(candidate) <= maxBytes) {
      packet = candidate
      return
    }
    if (hasSnapshotData(packet)) packets.push(packet)
    const single = { ...emptySnapshot(rosterAt), [key]: [value] } as DeviceSyncSnapshot
    if (deviceSyncPacketByteLength(single) > maxBytes) {
      throw new DeviceSyncProtocolError(`snapshot ${key} entry exceeds the packet limit`)
    }
    packet = single
  }

  for (const label of items.privateDeviceLabelsV2 ?? []) append('privateDeviceLabelsV2', label)
  for (const contact of items.privateContactsV2 ?? []) append('privateContactsV2', contact)
  for (const pin of items.chatPins ?? []) append('chatPins', pin)
  for (const mute of items.chatMutes ?? []) append('chatMutes', mute)
  for (const chat of items.chats) append('chats', chat)
  for (const appKeys of items.appKeys) append('appKeys', appKeys)
  for (const group of items.groups) append('groups', group)
  for (const message of items.messages) append('messages', message)
  if (hasSnapshotData(packet) || packets.length === 0) packets.push(packet)
  return packets
}

function rememberAppKeys(
  snapshots: Map<string, DeviceSyncAppKeys>,
  snapshot: DeviceSyncAppKeys,
): void {
  const ownerPubkey = snapshot.ownerPubkey.toLowerCase()
  const current = snapshots.get(ownerPubkey)
  if (current && current.createdAt > snapshot.createdAt) return
  const devices = current?.createdAt === snapshot.createdAt
    ? [...current.devices, ...snapshot.devices]
    : snapshot.devices
  const unique = new Map<string, DeviceSyncAppKeys['devices'][number]>()
  for (const device of devices) {
    const identityPubkey = device.identityPubkey.toLowerCase()
    const known = unique.get(identityPubkey)
    const labels = !known || (device.labelUpdatedAt ?? 0) >= (known.labelUpdatedAt ?? 0) ? device : known
    unique.set(identityPubkey, { ...labels, identityPubkey, createdAt: Math.min(device.createdAt, known?.createdAt ?? device.createdAt) })
  }
  snapshots.set(ownerPubkey, {
    ownerPubkey,
    createdAt: snapshot.createdAt,
    devices: [...unique.values()].sort((a, b) => a.identityPubkey.localeCompare(b.identityPubkey)),
  })
}

function scopedAppKeys(source: DeviceSyncSnapshotSource): DeviceSyncAppKeys[] {
  const owners = new Set([
    source.ownerPubkey,
    ...source.chats.map((chat) => chat.recipientPubkey),
    ...source.groups.flatMap((group) => group.members),
  ].map((owner) => owner.toLowerCase()))
  const snapshots = new Map<string, DeviceSyncAppKeys>()
  for (const snapshot of source.appKeys) {
    if (owners.has(snapshot.ownerPubkey.toLowerCase())) rememberAppKeys(snapshots, snapshot)
  }
  return [...snapshots.values()].sort((a, b) => a.ownerPubkey.localeCompare(b.ownerPubkey))
}

export function buildDeviceSyncSnapshots(
  source: DeviceSyncSnapshotSource,
  maxBytes = DEVICE_SYNC_MAX_PACKET_BYTES,
  includeMessages = true,
): DeviceSyncSnapshot[] {
  const rosterAt = Math.max(source.requestRosterAt, source.localRosterAt)
  const wireAppKeys = scopedAppKeys(source).map(snapshot => ({ ...snapshot,
    devices: snapshot.devices.map(device => ({ identityPubkey: device.identityPubkey, createdAt: device.createdAt })),
  }))
  const wireChats = source.chats.map((chat) => ({
    id: chat.id,
    updatedAt: chat.messages.reduce(
      (latest, message) => Math.max(latest, seconds(message.timestamp)),
      0,
    ),
  }))
  const wireGroups = source.groups.map((group) => {
    const messages = source.groupMessages.get(group.id) || []
    const createdAt = seconds(group.createdAt)
    const version = getGroupRosterVersion(group.id)
    return {
      id: group.id,
      name: group.name,
      ...(group.description && { description: group.description }),
      ...(group.picture && { picture: group.picture }),
      createdBy: group.admins[0] || source.ownerPubkey,
      members: [...group.members],
      admins: [...group.admins],
      revision: version?.revision ?? 0,
      createdAt,
      updatedAt: version?.updatedAt ?? messages.reduce(
        (latest, message) => Math.max(latest, seconds(message.timestamp)),
        createdAt,
      ),
      ...(group.accepted !== undefined && { accepted: group.accepted }),
      protocol: group.protocol ?? (group.secret ? 'sender_key_v1' as const : 'pairwise_fanout_v1' as const),
      ...(expirationStore.getExpiration(group.id) !== undefined && { legacyMessageTtlSeconds: expirationStore.getExpiration(group.id) }),
    }
  })
  const wireMessages = includeMessages ? collectDeviceSyncMessages(source, rosterAt) : []

  return chunkSnapshot(
    rosterAt,
    { appKeys: wireAppKeys, chats: wireChats, groups: wireGroups, messages: wireMessages, chatMutes: source.chatMutes, chatPins: source.chatPins, privateContactsV2: source.privateContactsV2, privateDeviceLabelsV2: source.privateDeviceLabelsV2 },
    maxBytes,
  )
}

function collectDeviceSyncMessages(
  source: DeviceSyncSnapshotSource,
  rosterAt: number,
): DeviceSyncMessage[] {
  const messages: DeviceSyncMessage[] = []
  for (const chat of source.chats) {
    for (const message of chat.messages) {
      const createdAt = seconds(message.timestamp)
      if (message.call || message.id.startsWith('call:') || createdAt < rosterAt || expired(message)) continue
      messages.push({
        chatId: chat.id,
        id: message.id,
        body: message.deletedAt !== undefined ? '' : message.originalContent ?? message.content,
        author: message.isMine ? source.ownerPubkey : message.senderPubkey || chat.recipientPubkey,
        createdAt,
        ...(message.expiresAt !== undefined && { expiresAt: message.expiresAt }),
      })
    }
  }
  for (const group of source.groups) {
    for (const message of source.groupMessages.get(group.id) || []) {
      const createdAt = seconds(message.timestamp)
      if (message.call || message.id.startsWith('call:') || createdAt < rosterAt || expired(message)) continue
      const author = message.isMine ? source.ownerPubkey : message.senderPubkey
      if (!author || !isPubkey(author)) continue
      messages.push({
        chatId: `group:${group.id}`,
        id: message.id,
        body: message.deletedAt !== undefined ? '' : message.originalContent ?? message.content,
        author,
        createdAt,
        ...(message.expiresAt !== undefined && { expiresAt: message.expiresAt }),
      })
    }
  }

  return messages.sort(compareDeviceSyncMessages)
}

function compareDeviceSyncMessages(
  left: Pick<DeviceSyncMessage, 'createdAt' | 'chatId' | 'id'>,
  right: Pick<DeviceSyncMessage, 'createdAt' | 'chatId' | 'id'>,
): number {
  return left.createdAt - right.createdAt ||
    compareString(left.chatId, right.chatId) || compareString(left.id, right.id)
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : Number(left > right)
}

function expired(message: { expiresAt?: number }): boolean {
  return message.expiresAt !== undefined && message.expiresAt <= Math.floor(Date.now() / 1000)
}

export function buildDeviceSyncReplyPackets(
  source: DeviceSyncSnapshotSource,
  page?: DeviceSyncPage,
  maxBytes = DEVICE_SYNC_MAX_PACKET_BYTES,
): DeviceSyncPacket[] {
  const rosterAt = Math.max(source.requestRosterAt, source.localRosterAt)
  const metadata = buildDeviceSyncSnapshots(source, maxBytes, false)
  const offset = page?.offset ?? 0
  const end = Math.min(offset + DEVICE_SYNC_PAGE_PACKETS, metadata.length)
  return [...metadata.slice(offset, end), { v: 1, type: 'pageEnd', rosterAt,
    next: end < metadata.length ? { kind: 'metadata', offset: end } : null }]
}

export function selectDeviceSyncAdditions(
  packet: DeviceSyncSnapshot,
  state: DeviceSyncMergeState,
): Pick<DeviceSyncSnapshot, 'appKeys' | 'chats' | 'groups' | 'messages'> {
  const cutoff = Math.max(packet.rosterAt, state.rosterAt)
  const missing = <T extends { id: string }>(items: T[], ids: Set<string>): T[] => {
    const seen = new Set(ids)
    return items.filter((item) => !seen.has(item.id) && !!seen.add(item.id))
  }
  const seenMessages = new Set(state.messageIds)
  const seenGroups = new Set<string>()
  const appKeys = new Map<string, DeviceSyncAppKeys>()
  for (const snapshot of packet.appKeys || []) rememberAppKeys(appKeys, snapshot)
  return {
    appKeys: [...appKeys.values()].sort((a, b) => a.ownerPubkey.localeCompare(b.ownerPubkey)),
    chats: missing(packet.chats, state.chatIds),
    groups: packet.groups.filter((group) => {
      if (seenGroups.has(group.id)) return false
      seenGroups.add(group.id)
      const local = state.groupVersions.get(group.id)
      return !local ||
        group.revision > local.revision ||
        (group.revision === local.revision && group.updatedAt > local.updatedAt)
    }),
    messages: packet.messages.filter(
      (message) => !message.id.startsWith('call:') && message.createdAt >= cutoff &&
        !expired(message) &&
        !seenMessages.has(message.id) &&
        !!seenMessages.add(message.id),
    ),
  }
}

function currentMergeState(): DeviceSyncMergeState {
  const chatMap = get(chats)
  const groupsMap = get(groups)
  const groupMap = get(groupMessages)
  return {
    rosterAt: get(devices).lastEventTimestamp,
    chatIds: new Set(chatMap.keys()),
    groupVersions: new Map(Array.from(groupsMap.values()).map((group) => [
      group.id,
      getGroupRosterVersion(group.id) || { revision: 0, updatedAt: seconds(group.createdAt) },
    ])),
    messageIds: new Set([
      ...Array.from(chatMap.values()).flatMap((chat) =>
        chat.messages.map((message) => message.id)),
      ...Array.from(groupMap.values()).flatMap((messages) =>
        messages.map((message) => message.id)),
    ]),
  }
}

function storedMessage(message: DeviceSyncMessage, isMine: boolean): StoredMessage {
  return {
    id: message.id,
    sessionId: message.chatId,
    content: message.body,
    timestamp: message.createdAt * 1000,
    isMine,
    senderPubkey: message.author,
    ...(message.expiresAt !== undefined && { expiresAt: message.expiresAt }),
  }
}

export async function applyDeviceSyncSnapshot(
  packet: DeviceSyncSnapshot,
  ownerPubkey = getPubkey() || '',
  historySince?: number,
  authorized: () => boolean = () => true,
  allowLegacyReactions = false,
): Promise<number> {
  let imported = 0
  if (!authorized()) return imported
  if (packet.privateContactsV2?.length) await mergePrivateContacts(ownerPubkey, packet.privateContactsV2)
  if (packet.chatPins?.length) await mergeChatPins(packet.chatPins, ownerPubkey)
  if (packet.chatMutes?.length) await mergeChatMutes(packet.chatMutes, ownerPubkey)
  const mergeState = currentMergeState()
  mergeState.rosterAt = historySince ?? localDeviceJoinedAt()
  const additions = selectDeviceSyncAdditions(packet, mergeState)
  if (!hasSnapshotData({ ...packet, ...additions })) return imported

  const runtime = getNdrRuntime()
  for (const snapshot of additions.appKeys) {
    await runtime.applyTrustedAppKeysSnapshot({
      ownerPubkey: snapshot.ownerPubkey,
      ...mergeDeviceDescriptions(snapshot, runtime.getKnownAppKeysSnapshots().find(known => known.ownerPubkey === snapshot.ownerPubkey)),
    })
  }

  if (!authorized()) return imported

  if (packet.privateDeviceLabelsV2?.length) await mergePrivateDeviceLabels(ownerPubkey, packet.privateDeviceLabelsV2)

  for (const chat of additions.chats) {
    if (!authorized()) return imported
    // Native includes group read-state rows here; groups have their own store.
    if (chat.id.startsWith('group:')) continue
    if (await isHistoryChatDeleted(chat.id)) continue
    const session: ChatSession = {
      id: chat.id,
      recipientPubkey: chat.id,
      mode: 'manager',
      messages: [],
    }
    applyStoreUpdate(() => chats.update((all) => new Map(all).set(chat.id, session)))
    await saveSession({
      id: chat.id,
      recipientPubkey: chat.id,
      createdAt: chat.updatedAt * 1000,
      mode: 'manager',
    })
  }

  for (const group of additions.groups) {
    if (!authorized()) return imported
    if (await isHistoryChatDeleted(`group:${group.id}`)) continue
    const existing = get(groups).get(group.id)
    if (!existing && !group.members.includes(ownerPubkey)) continue
    const local: Group = {
      id: group.id,
      name: group.name,
      ...(group.description && { description: group.description }),
      ...(group.picture && { picture: group.picture }),
      members: [...group.members],
      admins: [...group.admins],
      createdAt: group.createdAt * 1000,
      protocol: group.protocol ?? existing?.protocol,
      rosterVersion: { revision: group.revision, updatedAt: group.updatedAt, eventCreatedAt: group.updatedAt, eventId: '' },
      ...(existing?.secret && { secret: existing.secret }),
      ...((group.accepted ?? existing?.accepted) !== undefined && {
        accepted: group.accepted ?? existing?.accepted,
      }),
    }
    applyStoreUpdate(() => {
      groups.update((all) => new Map(all).set(group.id, local))
      groupMessages.update((all) => all.has(group.id) ? all : new Map(all).set(group.id, []))
    })
    if (!local.members.includes(ownerPubkey)) cancelGroupPublications(group.id)
    const stored: StoredGroup = { ...local }
    await saveGroup(stored)
    if (!existing && group.legacyMessageTtlSeconds !== undefined && expirationStore.getExpiration(group.id) === undefined &&
      !await groupSettingsHead(ownerPubkey, group.id) && authorized()) {
      expirationStore.setExpiration(group.id, group.legacyMessageTtlSeconds)
    }
    rememberSyncedGroupRosterVersion(group.id, group.revision, group.updatedAt)
  }
  if (additions.groups[0]) syncNativeGroupTransport(additions.groups[0].id)

  for (const message of additions.messages) {
    if (!authorized()) return imported
    const isMine = message.author.toLowerCase() === ownerPubkey.toLowerCase()
    if (message.chatId.startsWith('group:')) {
      const group = get(groups).get(message.chatId.slice(6))
      if (!group?.members.includes(ownerPubkey) || !group.members.includes(message.author)) continue
    } else if (message.author !== ownerPubkey && message.author !== message.chatId) continue
    const allowedAuthors = new Set(message.chatId.startsWith('group:') ? get(groups).get(message.chatId.slice(6))?.members : [ownerPubkey, message.chatId])
    const stored = await admitRecordMessage(ownerPubkey, storedMessage(message, isMine), message.legacyReactions, allowLegacyReactions, allowedAuthors, authorized)
    if (!stored) continue
    if (!authorized()) return imported
    imported += 1
    const local: ChatMessage = {
      id: message.id,
      content: stored.content,
      ...(!message.chatId.startsWith('group:') ? directFileMessageFields(message.body) : {}),
      timestamp: message.createdAt * 1000,
      isMine,
      senderPubkey: message.author,
      reactions: stored.reactions,
      ...messageMutationFields(stored),
      ...(message.expiresAt !== undefined && { expiresAt: message.expiresAt }),
    }
    if (message.chatId.startsWith('group:')) {
      const groupId = message.chatId.slice(6)
      applyStoreUpdate(() => groupMessages.update((all) => {
        const next = new Map(all)
        next.set(
          groupId,
          [...(next.get(groupId) || []), local].sort((a, b) => a.timestamp - b.timestamp),
        )
        return next
      }))
    } else {
      let updated: ChatSession | null = null
      applyStoreUpdate(() => chats.update((all) => {
        const next = new Map(all)
        const session = next.get(message.chatId) || {
          id: message.chatId,
          recipientPubkey: message.chatId,
          mode: 'manager' as const,
          messages: [],
        }
        updated = {
          ...session,
          messages: [...session.messages, local].sort((a, b) => a.timestamp - b.timestamp),
        }
        next.set(message.chatId, updated)
        return next
      }))
      if (updated && get(currentChat)?.id === message.chatId) currentChat.set(updated)
      if (!additions.chats.some((chat) => chat.id === message.chatId)) {
        await saveSession({
          id: message.chatId,
          recipientPubkey: message.chatId,
          createdAt: message.createdAt * 1000,
          mode: 'manager',
        })
      }
    }
  }
  return imported
}

function snapshotSource(requestRosterAt: number, ownerPubkey: string): DeviceSyncSnapshotSource {
  const state = get(devices)
  return {
    requestRosterAt,
    localRosterAt: state.lastEventTimestamp,
    ownerPubkey,
    appKeys: getNdrRuntime().getKnownAppKeysSnapshots().map((snapshot) => ({
      ownerPubkey: snapshot.ownerPubkey,
      createdAt: snapshot.createdAt,
      // Legacy roster fields contain only public authorization, never private names.
      devices: snapshot.appKeys.getAllDevices().map(({ identityPubkey, createdAt }) => ({ identityPubkey, createdAt })),
    })),
    chats: Array.from(get(chats).values()),
    chatMutes: Object.values(get(chatMuteStates)),
    chatPins: Object.values(get(chatPinStates)),
    privateContactsV2: getPrivateContactDocuments(),
    privateDeviceLabelsV2: getPrivateDeviceLabels(ownerPubkey),
    groups: Array.from(get(groups).values()),
    groupMessages: get(groupMessages),
  }
}

async function sendPackets(
  tcp: DeviceSyncTcp,
  peer: string,
  packets: DeviceSyncPacket[] | (() => DeviceSyncPacket[]),
): Promise<void> {
  try {
    const reply = typeof packets === 'function' ? packets() : packets
    for (const packet of reply) {
      if (!isAuthorizedDeviceSyncSource(peer, get(devices))) return
      await tcp.send(peer, encodeDeviceSyncPacket(packet))
    }
  } catch (error) {
    await tcp.sendFirst(peer, encodeDeviceSyncPacket({ v: 1, type: 'resyncRequired' }))
    throw error
  }
}

async function pushCurrentSnapshot(): Promise<void> {
  const tcp = activeTcp
  if (!tcp || !activeOwnerPubkey) return
  const state = get(devices)
  const packets = buildDeviceSyncReplyPackets(
    snapshotSource(state.lastEventTimestamp, activeOwnerPubkey),
  )
  await Promise.all(Array.from(activePeers).map(async (peer) => {
    if (!isAuthorizedDeviceSyncSource(peer, state)) return
    if (historyPeers.has(peer)) {
      await tcp.send(peer, encodeDeviceSyncPacket(historyRequest(activeOwnerPubkey)))
    } else await sendPackets(tcp, peer, packets)
  }))
}

function scheduleSnapshotPush(): void {
  if (suppressSnapshotPush) return
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    pushTimer = null
    void pushCurrentSnapshot().catch((error) =>
      console.warn('[deviceSync] Snapshot push failed:', error)
    )
  }, 100)
}

function localDeviceJoinedAt(): number {
  const state = get(devices)
  return state.registeredDevices.find(device => device.identityPubkey === state.identityPubkey)?.createdAt ?? state.lastEventTimestamp
}
function regularHistorySince(peer: string): number {
  const state = get(devices)
  return Math.max(localDeviceJoinedAt(), state.registeredDevices.find(device => device.identityPubkey === normalizedXOnly(peer))?.createdAt ?? state.lastEventTimestamp)
}
function currentHistoryPair(owner: string, peer: string) {
  const state = get(devices)
  const pair = deviceHistoryPair(owner, state.identityPubkey ?? '', normalizedXOnly(peer))
  const target = pair?.role === 'outbound' ? normalizedXOnly(peer) : state.identityPubkey
  return pair && pair.linkAt === state.registeredDevices.find(device => device.identityPubkey === target)?.createdAt ? pair : undefined
}

function servingHistorySince(owner: string, peer: string): number {
  const pair = currentHistoryPair(owner, peer)
  return pair?.role === 'outbound' && !pair.complete && pair.since === 0 ? 0 : regularHistorySince(peer)
}

function historyRequest(_owner: string, page?: DeviceSyncPage): DeviceSyncRequest {
  return { v: 1, type: 'request', rosterAt: get(devices).lastEventTimestamp, recordReconcile: 1, ...(page && { page }) }
}

function inventoryMessages(owner: string, since: number, until: number): DeviceSyncMessage[] {
  const source = snapshotSource(since, owner)
  source.groups = source.groups.filter(group => group.members.includes(owner))
  return collectDeviceSyncMessages(source, since).filter(message => message.createdAt <= until &&
    deviceSyncPacketByteLength({ v: 1, type: 'historyRecords', session: '0'.repeat(32), requested: [], records: [{ type: 'message', message }] }) <= DEVICE_SYNC_MAX_PACKET_BYTES)
}

async function handlePacket(
  source: string,
  payload: Uint8Array,
  ownerPubkey: string,
  tcp: DeviceSyncTcp,
  history: DeviceHistorySync,
): Promise<void> {
  const authorized = () => getPubkey() === ownerPubkey && isAuthorizedDeviceSyncSource(source, get(devices))
  if (!authorized()) return
  const packet = parseDeviceSyncPacket(payload, ownerPubkey)

  if (packet.type === 'request') {
    const pair = currentHistoryPair(ownerPubkey, source)
    const since = servingHistorySince(ownerPubkey, source)
    if (packet.recordReconcile === 1) {
      historyPeers.add(source)
      history.negotiate(source, since)
    }
    if (pair?.role === 'outbound') {
      await tcp.send(source, encodeDeviceSyncPacket({ v: 1, type: 'historyPolicy', linkAt: pair.linkAt, linkId: pair.linkId, since: pair.since ?? pair.linkAt }))
    } else if (pair?.complete && pair.role === 'inbound') {
      await tcp.send(source, encodeDeviceSyncPacket({ v: 1, type: 'historyComplete', linkAt: pair.linkAt, linkId: pair.linkId }))
    }
    const replies = buildDeviceSyncReplyPackets(snapshotSource(Math.max(packet.rosterAt, regularHistorySince(source)), ownerPubkey), packet.page)
    for (const reply of replies) if (packet.recordReconcile === 1 && reply.type === 'pageEnd') {
      reply.recordReconcile = 1
      reply.historySince = since
    }
    await sendPackets(tcp, source, replies)
    return
  }

  if (packet.type === 'resyncRequired' || packet.type === 'pageEnd') {
    if (packet.type === 'pageEnd' && packet.next === null) {
      if (packet.recordReconcile !== 1) return
      // The peer's receive cutoff must not replace our private serving grant.
      history.negotiate(source, servingHistorySince(ownerPubkey, source))
      await history.startState(source)
      const pair = currentHistoryPair(ownerPubkey, source)
      if (pair?.role === 'inbound' && !pair.complete && pair.since === 0) await history.start(source, 0, pair.linkAt - 1, pair.linkId)
      else await history.start(source, Math.max(regularHistorySince(source), packet.historySince ?? 0))
      return
    }
    if (packet.type === 'resyncRequired') history.reset(source)
    await tcp.sendFirst(source, encodeDeviceSyncPacket(historyRequest(ownerPubkey, packet.type === 'pageEnd' ? packet.next ?? undefined : undefined)))
    return
  }
  if (packet.type === 'historyPolicy' || packet.type === 'historyComplete') {
    const pair = currentHistoryPair(ownerPubkey, source)
    if (!pair || pair.linkAt !== packet.linkAt || pair.linkId !== packet.linkId) return
    const local = get(devices).identityPubkey!
    if (packet.type === 'historyPolicy' && pair.role === 'inbound' && !pair.complete) {
      await saveDeviceHistoryPair(ownerPubkey, local, { ...pair, since: packet.since, complete: packet.since !== 0 })
    } else if (packet.type === 'historyComplete') {
      if (pair.role === 'inbound' && !pair.complete) return
      await saveDeviceHistoryPair(ownerPubkey, local, { ...pair, complete: true })
      if (pair.role === 'outbound') await tcp.send(source, encodeDeviceSyncPacket(packet))
    }
    return
  }
  if (packet.type !== 'snapshot') { await history.receive(source, packet); return }
  applyQueue = applyQueue.catch(() => undefined).then(() => applyDeviceSyncSnapshot(packet, ownerPubkey, regularHistorySince(source), authorized))
  await applyQueue
  history.observe(source, [ ...packet.chats.map(chat => chat.updatedAt), ...packet.groups.map(group => group.updatedAt), ...packet.messages.map(message => message.createdAt) ])
}

function runtimeKey(ownerPubkey: string, state: DeviceState): string {
  return [
    ownerPubkey,
    ...get(callConnectionSettings).servers,
    ...get(callConnectionSettings).stunServers,
    state.identityPubkey,
    state.lastEventTimestamp,
    ...state.registeredDevices.map((device) => device.identityPubkey).sort(),
  ].join(':')
}

async function stopActiveNode(): Promise<void> {
  const node = activeNode
  const tcp = activeTcp
  activeNode = null
  activeTcp = null
  activeHistory?.reset()
  activeHistory = null
  historyPeers.clear()
  activeKey = ''
  activeOwnerPubkey = ''
  activePeers = new Set()
  detachCalls()
  await detachDirectFiles()
  await deactivateNostrPubsub()
  await deactivateAttachmentPeers()
  await tcp?.dispose().catch(() => undefined)
  await node?.stop().catch(() => undefined)
}

function reconcileRuntime(ownerPubkey: string, secretKey: Uint8Array, state: DeviceState): Promise<void> {
  // One roster update emits several store notifications while a node is still starting.
  const key = `${runtimeKey(ownerPubkey, state)}:${state.isCurrentDeviceRegistered}`
  if (pendingReconcile?.key === key) return pendingReconcile.promise
  const promise = updateRuntime(ownerPubkey, secretKey, state).finally(() => {
    if (pendingReconcile?.promise === promise) pendingReconcile = null
  })
  pendingReconcile = { key, promise }
  return promise
}

async function updateRuntime(
  ownerPubkey: string,
  secretKey: Uint8Array,
  state: DeviceState,
): Promise<void> {
  if (
    !state.identityPubkey ||
    !state.isCurrentDeviceRegistered ||
    state.lastEventTimestamp <= 0
  ) {
    generation += 1
    await stopActiveNode()
    return
  }

  const key = runtimeKey(ownerPubkey, state)
  if (activeKey === key) return
  const run = ++generation
  await stopActiveNode()
  const identity = await identityFromSecretKey(secretKey)
  if (toHex(identity.xOnlyPubkey) !== state.identityPubkey.toLowerCase()) {
    throw new Error('FIPS identity does not match the registered device')
  }

  const relays = Array.from(relayStore.getState().relays)
  if (relays.length === 0 || run !== generation) return
  const transport = new WebRtcTransport({
    relays,
    // STUN helps direct FIPS links cross NAT; local/routed paths remain available.
    stunServers: get(callConnectionSettings).stunServers,
    advertiseOnNostr: true,
    autoConnect: true,
    preferredAutoConnectPeers: state.registeredDevices
      .filter(device => device.identityPubkey !== state.identityPubkey)
      .flatMap(device => [`02${device.identityPubkey}`, `03${device.identityPubkey}`]),
    discoveryApp: DEVICE_SYNC_SCOPE,
    allowIncomingPeer: peer => isAuthorizedDeviceSyncSource(peer, get(devices)) || !!callOwnerForPeer(peer),
    maxConnections: Math.max(16, state.registeredDevices.length + 1),
    maxAutoConnections: 16,
    ordered: false,
    maxRetransmits: 0,
  })
  // Match Drive's admission on both sides of the shared WebRTC transport.
  const connect = transport.connect.bind(transport)
  transport.connect = async address => {
    if (!isAuthorizedDeviceSyncSource(address.addr, get(devices)) && !callOwnerForPeer(address.addr)) {
      throw new Error('This device is not an accepted contact')
    }
    await connect(address)
  }
  const seeds = get(callConnectionSettings).servers
  const transports = seeds.length ? [new WebSocketTransport({ seedUrls: seeds }), transport] : [transport]
  await loadDeviceHistoryPairs(ownerPubkey, state.identityPubkey!)
  await closeRevokedDeviceHistoryPairs(ownerPubkey, state.identityPubkey!, get(devices).registeredDevices.map(device => device.identityPubkey))
  const node = new FipsNode({ identity, transports, routingMode: 'reply_learned' })
  const peers = new Set<string>()
  const callPeers = new Set<string>()
  let tcp: DeviceSyncTcp
  const allowsLegacy = (peer: string, since: number, until: number, linkId?: string) => {
    const pair = currentHistoryPair(ownerPubkey, peer)
    return !!pair && !pair.complete && pair.since === 0 && since === 0 && until === pair.linkAt - 1 && linkId === pair.linkId
  }
  const history = new DeviceHistorySync({
    ...createDeviceSyncRecordAdapter({
      owner: ownerPubkey,
      snapshots: () => buildDeviceSyncSnapshots(snapshotSource(0, ownerPubkey), DEVICE_SYNC_MAX_PACKET_BYTES, false),
      messages: (since, until) => inventoryMessages(ownerPubkey, since, until),
      cachedProfiles: async contacts => (await get(nostrClient).runtime.query([{ kinds: [0], authors: contacts, limit: contacts.length }], { cache: 'cache-only' })).events,
      allowsLegacy,
      applySnapshot: async (packet, since, authorized, legacy) => {
        const count = await applyDeviceSyncSnapshot(packet, ownerPubkey, since, authorized, legacy)
        for (const message of packet.messages) if (authorized() && !await isHistoryMessageSettled(message)) throw new Error('History message was not saved')
        return count
      },
    }),
    authorized: peer => run === generation && isAuthorizedDeviceSyncSource(peer, get(devices)),
    floor: peer => servingHistorySince(ownerPubkey, peer),
    allowsWindow: (peer, since, until, linkId) => {
      if (since >= regularHistorySince(peer)) return true
      const pair = currentHistoryPair(ownerPubkey, peer)
      return !!pair && pair.role === 'outbound' && !pair.complete && pair.since === 0 && since === 0 && until === pair.linkAt - 1 && linkId === pair.linkId
    },
    progress: (peer, since, imported, total) => {
      const pair = currentHistoryPair(ownerPubkey, peer)
      if (since === 0 && pair?.role === 'inbound' && !pair.complete) deviceHistoryProgress.set({ phase: total === undefined && imported === 0 ? 'discovering' : 'transferring', imported, ...(total !== undefined && { total }) })
    },
    complete: async (peer, since, until, withheld) => {
      const pair = currentHistoryPair(ownerPubkey, peer)
      if (since !== 0 || !pair || pair.role !== 'inbound' || pair.complete || until !== pair.linkAt - 1) return
      if (withheld) { void history.start(peer, 0, pair.linkAt - 1, pair.linkId); return }
      await saveDeviceHistoryPair(ownerPubkey, get(devices).identityPubkey!, { ...pair, complete: true })
      await tcp.send(peer, encodeDeviceSyncPacket({ v: 1, type: 'historyComplete', linkAt: pair.linkAt, linkId: pair.linkId }))
      void history.start(peer, regularHistorySince(peer))
    },
    unavailable: (peer, since) => {
      const pair = currentHistoryPair(ownerPubkey, peer)
      if (since === 0 && pair?.role === 'inbound' && !pair.complete) deviceHistoryProgress.update(progress => ({ phase: 'waiting', imported: progress?.imported ?? 0 }))
    },
    send: (peer, packet) => tcp.send(peer, encodeDeviceSyncPacket(packet)),
  })
  tcp = new DeviceSyncTcp({
    endpoint: node,
    localPeer: state.identityPubkey,
    port: DEVICE_SYNC_PORT,
    maxRecordBytes: DEVICE_SYNC_MAX_PACKET_BYTES,
    onRecord: (source, payload) => handlePacket(source, payload, ownerPubkey, tcp, history),
    onConnected: (peer) => {
      history.reset(peer)
      const request = historyRequest(ownerPubkey)
      void tcp.sendFirst(peer, encodeDeviceSyncPacket(request))
        .catch((error) => console.warn('[deviceSync] Request failed:', error))
    },
    onError: (error) => console.warn('[deviceSync] TCP error:', error),
  })
  node.on('peer', (value) => {
    const peer = value as PeerEvent
    const syncPeer = normalizeDeviceSyncPeer(peer.remotePubkey)
    if (peer.state === 'disconnected') {
      callPeers.delete(peer.remotePubkey)
      peers.delete(syncPeer)
      history.reset(syncPeer)
      const pending = currentHistoryPair(ownerPubkey, syncPeer)
      if (pending?.role === 'inbound' && !pending.complete && pending.since === 0) deviceHistoryProgress.update(progress => ({ phase: 'waiting', imported: progress?.imported ?? 0, ...(progress?.total !== undefined && { total: progress.total }) }))
      historyPeers.delete(syncPeer)
      tcp.setPeer(syncPeer, false)
      return
    }
    callPeers.add(peer.remotePubkey)
    if (
      !isAuthorizedDeviceSyncSource(peer.remotePubkey, get(devices))
    ) return
    peers.add(syncPeer)
    tcp.setPeer(syncPeer, true)
  })
  node.on('error', (error) => console.warn('[deviceSync] FIPS error:', error))
  attachCalls(node, () => Array.from(callPeers), async owner => {
    await Promise.allSettled(knownCallDevices(owner).map(async device => {
      const peer = await transport.resolve(deriveNodeAddr(fromHex(device)))
      if (peer) await node.connect(peer.remoteAddr)
    }))
  }, async call => {
    const { preparePeerNdrRuntime } = await import('./privateChats')
    const runtime = await preparePeerNdrRuntime(call.owner)
    await sendCallWakeups(secretKey, ownerPubkey, call.peers, call.id, call.video,
      get(notificationSettings).serverUrl, event => new AppEvent(get(nostrClient), event).publish(),
      rumor => runtime.sendEvent(call.owner, rumor, ownerPubkey, { includeLocalSiblings: false }),
      () => run === generation && getPubkey() === ownerPubkey)
  })
  try {
    await node.start()
  } catch (error) {
    if (run === generation) detachCalls()
    await tcp.dispose().catch(() => undefined)
    await node.stop().catch(() => undefined)
    throw error
  }
  if (run !== generation) {
    await tcp.dispose()
    await node.stop()
    return
  }
  activeNode = node
  activeTcp = tcp
  activeHistory = history
  activeKey = key
  activeOwnerPubkey = ownerPubkey
  activePeers = peers
  await attachDirectFiles(node, ownerPubkey, secretKey, async device => {
    const peer = await transport.resolve(deriveNodeAddr(fromHex(device)))
    if (peer) await node.connect(peer.remoteAddr)
  })
  // Message synchronization remains restricted to this account's registered devices.
  await activateNostrPubsub(node, toHex(identity.publicKey), () => Array.from(peers), get(nostrClient).runtime)
  activateAttachmentPeers(node, () => [...new Set([
    ...callPeers,
    ...get(devices).registeredDevices.map(device => `02${device.identityPubkey}`),
    ...Array.from(get(chats).values()).flatMap(chat => knownCallDevices(chat.recipientPubkey).map(device => `02${device}`)),
  ])].filter(peer => peer !== toHex(identity.publicKey) &&
    (isAuthorizedDeviceSyncSource(peer, get(devices)) || !!callOwnerForPeer(peer))),
    peer => isAuthorizedDeviceSyncSource(peer, get(devices)) || !!callOwnerForPeer(peer))
}

export function startDeviceSync(ownerPubkey: string, secretKey: Uint8Array): void {
  deviceUnsubscribe?.()
  for (const unsubscribe of storeUnsubscribers) unsubscribe()
  void loadChatPins(ownerPubkey).catch(error => console.warn('Could not load pin settings', error))
  void loadChatMutes(ownerPubkey).catch(error => console.warn('Could not load mute settings', error))
  storeUnsubscribers = [chats, groups, groupMessages, chatMuteStates, chatPinStates, privateContactsVersion, deviceRecordVersion].map((store) =>
    store.subscribe(scheduleSnapshotPush)
  )
  storeUnsubscribers.push(startChatMuteSync(ownerPubkey))
  const key = new Uint8Array(secretKey)
  storeUnsubscribers.push(callConnectionSettings.subscribe(() => {
    void reconcileRuntime(ownerPubkey, key, get(devices)).catch(error => console.warn('[calls] Connection failed:', error))
  }))
  let requestedRoster = ''
  const reconcilePrivateContacts = (state: DeviceState) => {
    if (getPubkey() !== ownerPubkey) return
    const roster = state.isCurrentDeviceRegistered ? state.registeredDevices.map(device => device.identityPubkey).sort().join(',') : ''
    if (roster && roster !== requestedRoster) {
      requestedRoster = roster
      void requestPrivateContactSync(ownerPubkey).catch(() => { requestedRoster = '' })
    }
  }
  const contactsTimer = setInterval(() => reconcilePrivateContacts(get(devices)), 5000)
  storeUnsubscribers.push(() => clearInterval(contactsTimer))
  deviceUnsubscribe = devices.subscribe((state) => {
    if (state.identityPubkey && state.lastEventTimestamp > 0) void closeRevokedDeviceHistoryPairs(ownerPubkey, state.identityPubkey, (state.isCurrentDeviceRegistered ? state.registeredDevices.map(device => device.identityPubkey) : [])).catch(error => console.warn('Could not close removed device history', error))
    reconcilePrivateContacts(state)
    void refreshCurrentDeviceDescription(ownerPubkey).catch(error => console.warn('Could not sync device name', error))
    void reconcileRuntime(ownerPubkey, key, state).catch((error) =>
      console.warn('[deviceSync] Runtime start failed:', error)
    )
  })
}

export async function stopDeviceSync(): Promise<void> {
  deviceHistoryProgress.set(null)
  generation += 1
  pendingReconcile = null
  deviceUnsubscribe?.()
  deviceUnsubscribe = null
  for (const unsubscribe of storeUnsubscribers) unsubscribe()
  storeUnsubscribers = []
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = null
  await stopActiveNode()
}

// Legacy roster snapshots cannot import private names into the new sync channel.
export function mergeDeviceDescriptions(snapshot: DeviceSyncAppKeys, current?: { createdAt: number; appKeys: AppKeys }): { createdAt: number; appKeys: AppKeys } {
  const appKeys = new AppKeys(current && current.createdAt > snapshot.createdAt ? current.appKeys.getAllDevices() : snapshot.devices)
  for (const device of appKeys.getAllDevices()) {
    const known = current?.appKeys.getDeviceLabels(device.identityPubkey)
    if (known) appKeys.setDeviceLabels(device.identityPubkey, known, known.updatedAt)
  }
  return { createdAt: Math.max(snapshot.createdAt, current?.createdAt ?? 0), appKeys }
}

async function refreshCurrentDeviceDescription(ownerPubkey: string): Promise<void> {
  const labels = await getCurrentDeviceRegistrationLabels()
  if (getPubkey() !== ownerPubkey) return
  const runtime = getNdrRuntime()
  const current = runtime.getKnownAppKeysSnapshots().find(snapshot => snapshot.ownerPubkey === ownerPubkey)
  const device = get(devices).identityPubkey
  if (!current || !device || !current.appKeys.getDevice(device)) return
  const known = current.appKeys.getDeviceLabels(device)
  labels.deviceLabel = meaningfulDeviceName(known?.deviceLabel) || labels.deviceLabel
  if (known?.deviceLabel === labels.deviceLabel && known?.clientLabel === labels.clientLabel) return
  const appKeys = new AppKeys(current.appKeys.getAllDevices(), current.appKeys.getAllDeviceLabels())
  appKeys.setDeviceLabels(device, labels, Math.max(Math.floor(Date.now() / 1000), (known?.updatedAt ?? 0) + 1))
  await runtime.applyTrustedAppKeysSnapshot({ ...current, appKeys })
  scheduleSnapshotPush()
  await sendPrivateDeviceLabels(ownerPubkey)
}

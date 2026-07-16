import { get } from 'svelte/store'
import {
  FipsNode,
  identityFromSecretKey,
  toHex,
  type PeerEvent,
} from '@fips/core'
import { WebRtcTransport } from '@fips/transport-webrtc'
import { AppKeys } from 'nostr-double-ratchet'
import { chats, currentChat, type ChatMessage, type ChatSession } from './chat'
import { devices, type DeviceState } from './devices'
import { getPubkey } from './identity'
import { getNdrRuntime } from './privateChats'
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
import { DeviceSyncTcp } from './deviceSyncTcp'
import {
  saveGroup,
  saveMessage,
  saveSession,
  type StoredGroup,
  type StoredMessage,
} from './storage'
import {
  DEVICE_SYNC_MAX_PACKET_BYTES,
  DEVICE_SYNC_PAGE_MESSAGES,
  DEVICE_SYNC_PAGE_PACKETS,
  DEVICE_SYNC_PORT,
  DeviceSyncProtocolError,
  deviceSyncPacketByteLength,
  encodeDeviceSyncPacket,
  parseDeviceSyncPacket,
  type DeviceSyncAppKeys,
  type DeviceSyncCursor,
  type DeviceSyncGroup,
  type DeviceSyncMessage,
  type DeviceSyncPacket,
  type DeviceSyncPage,
  type DeviceSyncRequest,
  type DeviceSyncSnapshot,
} from './deviceSyncProtocol'

export {
  DEVICE_SYNC_MAX_PACKET_BYTES,
  DEVICE_SYNC_PAGE_MESSAGES,
  DEVICE_SYNC_PAGE_PACKETS,
  DEVICE_SYNC_PORT,
  parseDeviceSyncPacket,
} from './deviceSyncProtocol'
export type {
  DeviceSyncAppKeys,
  DeviceSyncCursor,
  DeviceSyncGroup,
  DeviceSyncMessage,
  DeviceSyncPacket,
  DeviceSyncPage,
  DeviceSyncRequest,
  DeviceSyncSnapshot,
} from './deviceSyncProtocol'

const DEVICE_SYNC_SCOPE = 'iris-chat-device-sync-v1'
const STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
  'stun:global.stun.twilio.com:3478',
]

export interface DeviceSyncSnapshotSource {
  requestRosterAt: number
  localRosterAt: number
  ownerPubkey: string
  appKeys: DeviceSyncAppKeys[]
  chats: ChatSession[]
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
let activeKey = ''
let activeOwnerPubkey = ''
let activePeers = new Set<string>()
let deviceUnsubscribe: (() => void) | null = null
let storeUnsubscribers: Array<() => void> = []
let pushTimer: ReturnType<typeof setTimeout> | null = null
let suppressSnapshotPush = false
let generation = 0
let applyQueue = Promise.resolve()

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
  return packet.appKeys.length + packet.chats.length + packet.groups.length + packet.messages.length > 0
}

function chunkSnapshot(
  rosterAt: number,
  items: Pick<DeviceSyncSnapshot, 'appKeys' | 'chats' | 'groups' | 'messages'>,
  maxBytes: number,
): DeviceSyncSnapshot[] {
  const packets: DeviceSyncSnapshot[] = []
  let packet = emptySnapshot(rosterAt)

  const append = <K extends 'appKeys' | 'chats' | 'groups' | 'messages'>(
    key: K,
    value: DeviceSyncSnapshot[K][number],
  ) => {
    const candidate = { ...packet, [key]: [...packet[key], value] } as DeviceSyncSnapshot
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
  const unique = new Map<string, { identityPubkey: string; createdAt: number }>()
  for (const device of devices) {
    const identityPubkey = device.identityPubkey.toLowerCase()
    const known = unique.get(identityPubkey)
    if (!known || device.createdAt < known.createdAt) {
      unique.set(identityPubkey, { identityPubkey, createdAt: device.createdAt })
    }
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
  const wireAppKeys = scopedAppKeys(source)
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
      protocol: group.secret ? 'sender_key_v1' as const : 'pairwise_fanout_v1' as const,
    }
  })
  const wireMessages = includeMessages ? collectDeviceSyncMessages(source, rosterAt) : []

  return chunkSnapshot(
    rosterAt,
    { appKeys: wireAppKeys, chats: wireChats, groups: wireGroups, messages: wireMessages },
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
      if (createdAt < rosterAt || expired(message)) continue
      messages.push({
        chatId: chat.id,
        id: message.id,
        body: message.content,
        author: message.isMine ? source.ownerPubkey : message.senderPubkey || chat.recipientPubkey,
        createdAt,
        ...(message.expiresAt !== undefined && { expiresAt: message.expiresAt }),
      })
    }
  }
  for (const group of source.groups) {
    for (const message of source.groupMessages.get(group.id) || []) {
      const createdAt = seconds(message.timestamp)
      if (createdAt < rosterAt || expired(message)) continue
      const author = message.isMine ? source.ownerPubkey : message.senderPubkey
      if (!author || !isPubkey(author)) continue
      messages.push({
        chatId: `group:${group.id}`,
        id: message.id,
        body: message.content,
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

function messageAfterCursor(message: DeviceSyncMessage, cursor: DeviceSyncCursor): boolean {
  return compareDeviceSyncMessages(message, cursor) > 0
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
  if (!page || page.kind === 'metadata') {
    const metadata = buildDeviceSyncSnapshots(source, maxBytes, false)
    const offset = page?.offset ?? 0
    const end = Math.min(offset + DEVICE_SYNC_PAGE_PACKETS, metadata.length)
    const next: DeviceSyncPage = end < metadata.length
      ? { kind: 'metadata', offset: end }
      : { kind: 'messages', after: null }
    return [
      ...metadata.slice(offset, end),
      { v: 1, type: 'pageEnd', rosterAt, next },
    ]
  }

  const remaining = collectDeviceSyncMessages(source, rosterAt)
    .filter((message) => !page.after || messageAfterCursor(message, page.after))
  const messages = remaining.slice(0, DEVICE_SYNC_PAGE_MESSAGES)
  const packets: DeviceSyncPacket[] = chunkSnapshot(
    rosterAt,
    { appKeys: [], chats: [], groups: [], messages },
    maxBytes,
  )
  if (remaining.length > messages.length) {
    const last = messages.at(-1)!
    packets.push({
      v: 1,
      type: 'pageEnd',
      rosterAt,
      next: {
        kind: 'messages',
        after: { createdAt: last.createdAt, chatId: last.chatId, id: last.id },
      },
    })
  }
  return packets
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
      (message) => message.createdAt >= cutoff &&
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
): Promise<void> {
  const additions = selectDeviceSyncAdditions(packet, currentMergeState())
  if (!hasSnapshotData({ ...packet, ...additions })) return

  const runtime = getNdrRuntime()
  for (const snapshot of additions.appKeys) {
    await runtime.applyTrustedAppKeysSnapshot({
      ownerPubkey: snapshot.ownerPubkey,
      createdAt: snapshot.createdAt,
      appKeys: new AppKeys(snapshot.devices),
    })
  }

  for (const chat of additions.chats) {
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
    const existing = get(groups).get(group.id)
    const local: Group = {
      id: group.id,
      name: group.name,
      ...(group.description && { description: group.description }),
      ...(group.picture && { picture: group.picture }),
      members: [...group.members],
      admins: [...group.admins],
      createdAt: group.createdAt * 1000,
      ...(existing?.secret && { secret: existing.secret }),
      ...((group.accepted ?? existing?.accepted) !== undefined && {
        accepted: group.accepted ?? existing?.accepted,
      }),
    }
    applyStoreUpdate(() => {
      groups.update((all) => new Map(all).set(group.id, local))
      groupMessages.update((all) => all.has(group.id) ? all : new Map(all).set(group.id, []))
    })
    const stored: StoredGroup = { ...local }
    await saveGroup(stored)
    rememberSyncedGroupRosterVersion(group.id, group.revision, group.updatedAt)
  }
  if (additions.groups[0]) syncNativeGroupTransport(additions.groups[0].id)

  for (const message of additions.messages) {
    const isMine = message.author.toLowerCase() === ownerPubkey.toLowerCase()
    const local: ChatMessage = {
      id: message.id,
      content: message.body,
      timestamp: message.createdAt * 1000,
      isMine,
      senderPubkey: message.author,
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
    await saveMessage(storedMessage(message, isMine))
  }
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
      devices: snapshot.appKeys.getAllDevices().map(({ identityPubkey, createdAt }) => ({
        identityPubkey,
        createdAt,
      })),
    })),
    chats: Array.from(get(chats).values()),
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
    for (const packet of reply) await tcp.send(peer, encodeDeviceSyncPacket(packet))
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
    await sendPackets(tcp, peer, packets)
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

async function handlePacket(
  source: string,
  payload: Uint8Array,
  ownerPubkey: string,
  tcp: DeviceSyncTcp,
): Promise<void> {
  if (!isAuthorizedDeviceSyncSource(source, get(devices))) return
  const packet = parseDeviceSyncPacket(payload, ownerPubkey)

  if (packet.type === 'request') {
    await sendPackets(tcp, source, () => buildDeviceSyncReplyPackets(
      snapshotSource(packet.rosterAt, ownerPubkey),
      packet.page,
    ))
    return
  }

  if (packet.type === 'resyncRequired' || packet.type === 'pageEnd') {
    const request: DeviceSyncRequest = {
      v: 1,
      type: 'request',
      rosterAt: get(devices).lastEventTimestamp,
      ...(packet.type === 'pageEnd' && { page: packet.next }),
    }
    await tcp.sendFirst(source, encodeDeviceSyncPacket(request))
    return
  }

  applyQueue = applyQueue.catch(() => undefined).then(() =>
    applyDeviceSyncSnapshot(packet, ownerPubkey)
  )
  await applyQueue
}

function runtimeKey(ownerPubkey: string, state: DeviceState): string {
  return [
    ownerPubkey,
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
  activeKey = ''
  activeOwnerPubkey = ''
  activePeers = new Set()
  await deactivateNostrPubsub()
  await tcp?.dispose().catch(() => undefined)
  await node?.stop().catch(() => undefined)
}

async function reconcileRuntime(
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
  const siblingCount = Math.max(0, state.registeredDevices.length - 1)
  const transport = new WebRtcTransport({
    relays,
    stunServers: STUN_SERVERS,
    advertiseOnNostr: true,
    autoConnect: true,
    discoveryApp: `${DEVICE_SYNC_SCOPE}:${ownerPubkey.toLowerCase()}`,
    maxConnections: Math.max(4, state.registeredDevices.length + 1),
    maxAutoConnections: siblingCount,
  })
  const node = new FipsNode({ identity, transports: [transport] })
  const peers = new Set<string>()
  let tcp: DeviceSyncTcp
  tcp = new DeviceSyncTcp({
    endpoint: node,
    localPeer: state.identityPubkey,
    port: DEVICE_SYNC_PORT,
    maxRecordBytes: DEVICE_SYNC_MAX_PACKET_BYTES,
    onRecord: (source, payload) => handlePacket(source, payload, ownerPubkey, tcp),
    onConnected: (peer) => {
      const request: DeviceSyncRequest = {
        v: 1,
        type: 'request',
        rosterAt: get(devices).lastEventTimestamp,
      }
      void tcp.sendFirst(peer, encodeDeviceSyncPacket(request))
        .catch((error) => console.warn('[deviceSync] Request failed:', error))
    },
    onError: (error) => console.warn('[deviceSync] TCP error:', error),
  })
  node.on('peer', (value) => {
    const peer = value as PeerEvent
    if (peer.state === 'disconnected') {
      peers.delete(peer.remotePubkey)
      tcp.setPeer(peer.remotePubkey, false)
      return
    }
    if (
      !isAuthorizedDeviceSyncSource(peer.remotePubkey, get(devices))
    ) return
    peers.add(peer.remotePubkey)
    tcp.setPeer(peer.remotePubkey, true)
  })
  node.on('error', (error) => console.warn('[deviceSync] FIPS error:', error))
  await node.start()
  if (run !== generation) {
    await tcp.dispose()
    await node.stop()
    return
  }
  activeNode = node
  activeTcp = tcp
  activeKey = key
  activeOwnerPubkey = ownerPubkey
  activePeers = peers
  // This first production lane is intentionally limited to machine-admitted
  // sibling devices discovered by the owner-scoped transport above.
  await activateNostrPubsub(node, () => Array.from(peers))
}

export function startDeviceSync(ownerPubkey: string, secretKey: Uint8Array): void {
  deviceUnsubscribe?.()
  for (const unsubscribe of storeUnsubscribers) unsubscribe()
  storeUnsubscribers = [chats, groups].map((store) =>
    store.subscribe(scheduleSnapshotPush)
  )
  const key = new Uint8Array(secretKey)
  deviceUnsubscribe = devices.subscribe((state) => {
    void reconcileRuntime(ownerPubkey, key, state).catch((error) =>
      console.warn('[deviceSync] Runtime start failed:', error)
    )
  })
}

export async function stopDeviceSync(): Promise<void> {
  generation += 1
  deviceUnsubscribe?.()
  deviceUnsubscribe = null
  for (const unsubscribe of storeUnsubscribers) unsubscribe()
  storeUnsubscribers = []
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = null
  await stopActiveNode()
}

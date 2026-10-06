import { get, writable } from 'svelte/store'
import type { Writable } from 'svelte/store'
import { Reconciliation } from 'nostr-pubsub-reconcile'
import { historyRecordId } from './deviceHistorySync'
import { bytesToHex } from '@noble/hashes/utils.js'
import { AppKeys } from 'nostr-double-ratchet'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from './chat'
import type { DeviceState } from './devices'
import type { Group } from './groups'

const fips = vi.hoisted(() => ({
  transports: [] as Array<Record<string, unknown>>,
  nodes: [] as Array<{ emit: (event: string, value: unknown) => void; stop: ReturnType<typeof vi.fn> }>,
  start: vi.fn(async () => undefined),
  sendDatagram: vi.fn(async () => undefined),
}))
const tcp = vi.hoisted(() => ({
  instances: [] as Array<{
    port: number
    send: ReturnType<typeof vi.fn>
    sendFirst: ReturnType<typeof vi.fn>
    setPeer: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    onRecord: (source: string, payload: Uint8Array) => Promise<void>
    onConnected?: (peer: string) => void
  }>,
}))
const groupRoster = vi.hoisted(() =>
  new Map<string, { revision: number; updatedAt: number }>()
)
const ndr = vi.hoisted(() => ({
  knownSnapshots: [] as Array<{
    ownerPubkey: string
    createdAt: number
    appKeys: { getAllDevices: () => Array<{ identityPubkey: string; createdAt: number }> }
  }>,
  applyTrustedAppKeysSnapshot: vi.fn(async () => 'advanced'),
}))

vi.mock('./directFiles', () => ({
  attachDirectFiles: vi.fn(async () => undefined),
  detachDirectFiles: vi.fn(async () => undefined),
}))

vi.mock('@fips/core', () => ({
  FipsNode: class {
    private listeners = new Map<string, Set<(value: unknown) => void>>()
    constructor() { fips.nodes.push(this) }
    registerService() { return () => undefined }
    on(event: string, listener: (value: unknown) => void) {
      const listeners = this.listeners.get(event) ?? new Set()
      listeners.add(listener)
      this.listeners.set(event, listeners)
      return () => listeners.delete(listener)
    }
    emit(event: string, value: unknown) { for (const listener of this.listeners.get(event) ?? []) listener(value) }
    start = vi.fn(() => fips.start())
    stop = vi.fn(async () => undefined)
    sendDatagram = fips.sendDatagram
  },
  identityFromSecretKey: vi.fn(async () => ({ xOnlyPubkey: new Uint8Array(32), publicKey: new Uint8Array(33) })),
  toHex: vi.fn((bytes: Uint8Array) => `${bytes.length === 33 ? '02' : ''}${'a'.repeat(64)}`),
}))
vi.mock('@fips/transport-webrtc', async importOriginal => ({
  ...await importOriginal<typeof import('@fips/transport-webrtc')>(),
  WebRtcTransport: class {
    constructor(config: Record<string, unknown>) { fips.transports.push(config) }
    connect = vi.fn(async () => undefined)
  },
}))
vi.mock('./deviceSyncTcp', async importOriginal => ({
  normalizeDeviceSyncPeer: (await importOriginal<typeof import('./deviceSyncTcp')>()).normalizeDeviceSyncPeer,
  DeviceSyncTcp: class {
    port: number
    send = vi.fn(async () => undefined)
    sendFirst = vi.fn(async () => undefined)
    setPeer = vi.fn()
    dispose = vi.fn(async () => undefined)
    onRecord: (source: string, payload: Uint8Array) => Promise<void>
    onConnected?: (peer: string) => void
    constructor(options: {
      port: number
      onRecord: (source: string, payload: Uint8Array) => Promise<void>
      onConnected?: (peer: string) => void
    }) {
      this.port = options.port
      this.onRecord = options.onRecord
      this.onConnected = options.onConnected
      tcp.instances.push(this)
    }
  },
}))
vi.mock('./chat', () => ({
  chats: writable(new Map()),
  currentChat: writable(null),
}))
vi.mock('./devices', () => ({
  devices: writable({
    identityPubkey: 'a'.repeat(64),
    registeredDevices: [
      { identityPubkey: 'a'.repeat(64), createdAt: 90 },
      { identityPubkey: 'b'.repeat(64), createdAt: 100 },
    ],
    isCurrentDeviceRegistered: true,
    appKeysManagerReady: true,
    sessionManagerReady: true,
    hasLocalAppKeys: true,
    lastEventTimestamp: 100,
  }),
}))
vi.mock('./groups', () => ({
  groups: writable(new Map()),
  groupMessages: writable(new Map()),
  getGroupRosterVersion: vi.fn((id: string) => groupRoster.get(id)),
  rememberSyncedGroupRosterVersion: vi.fn((id: string, revision: number, updatedAt: number) =>
    groupRoster.set(id, { revision, updatedAt })
  ),
  syncNativeGroupTransport: vi.fn(),
}))
vi.mock('./notifications', () => ({ updateDMSubscription: vi.fn(async () => {}) }))
vi.mock('./identity', () => ({
  identity: writable({ pubkey: 'a'.repeat(64) }),
  getPubkey: vi.fn(() => 'a'.repeat(64)),
  nostrClient: writable({ runtime: { addSource: vi.fn(), removeSource: vi.fn() } }),
}))
vi.mock('./privateChats', () => ({
  cancelGroupPublications: vi.fn(),
  getNdrRuntime: () => ({
    getKnownAppKeysSnapshots: () => ndr.knownSnapshots,
    applyTrustedAppKeysSnapshot: ndr.applyTrustedAppKeysSnapshot,
  }),
}))
vi.mock('./relayStore', () => ({
  relayStore: { getState: () => ({ relays: new Set(['wss://relay.example']) }) },
}))
vi.mock('./deviceSyncRecordApply', () => ({ admitRecordMessage: async (_owner: string, value: unknown) => value }))
vi.mock('./messageMutations', async importOriginal => ({ ...await importOriginal<typeof import('./messageMutations')>(), messageMutationRecords: async function* () {} }))
vi.mock('./deviceSyncRecordStore', () => ({ deviceRecordVersion: writable(0), messageWithReactionHeads: async (_owner: string, value: unknown) => value, hasReactionHead: async () => false, groupSettingsHead: async () => undefined, reactionHeads: async function* () {}, reactionHeadPages: async function* () {}, groupSettingsHeads: async function* () {} }))
vi.mock('./storage', () => ({
  db: { transaction: async (...args: any[]) => args.at(-1)(), messages: { get: async () => undefined }, sessionManager: { get: async () => undefined } },
  getSessionManagerValue: vi.fn(async () => undefined),
  putSessionManagerValue: vi.fn(async () => {}),
  deleteSessionManagerValue: vi.fn(async () => {}),
  saveGroup: vi.fn(),
  saveMessage: vi.fn(),
  isHistoryMessageSettled: vi.fn().mockResolvedValue(true),
  admitHistoryMessage: vi.fn(async () => true),
  deletedHistoryRecords: vi.fn(async function* () {}),
  isHistoryChatDeleted: vi.fn(async () => false),
  saveSession: vi.fn(),
}))

import {
  buildDeviceSyncSnapshots,
  mergeDeviceDescriptions,
  buildDeviceSyncReplyPackets,
  DEVICE_SYNC_MAX_PACKET_BYTES,
  DEVICE_SYNC_RECORD_BATCH,
  DEVICE_SYNC_PAGE_PACKETS,
  DEVICE_SYNC_PORT,
  applyDeviceSyncSnapshot,
  isAuthorizedDeviceSyncSource,
  parseDeviceSyncPacket,
  selectDeviceSyncAdditions,
  startDeviceSync,
  stopDeviceSync,
  type DeviceSyncAppKeys,
  type DeviceSyncMessage,
  type DeviceSyncSnapshot,
} from './deviceSync'
import { encodeDeviceSyncPacket } from './deviceSyncProtocol'
import { chats } from './chat'
import { groups } from './groups'
import { nostrClient } from './identity'
import { devices } from './devices'
import { expirationStore } from './expirationStore'
import { chatMutes, clearChatMutes } from './chatMuteStore'
import { deviceHistoryPair, saveDeviceHistoryPair } from './deviceHistoryPolicy'
import { pinnedChatIds, clearChatPins } from './chatPinStore'

const owner = 'a'.repeat(64)
const device = 'b'.repeat(64)
const peerOwner = 'c'.repeat(64)
const groupMember = 'd'.repeat(64)
const unrelatedOwner = 'e'.repeat(64)

function deviceState(overrides: Partial<DeviceState> = {}): DeviceState {
  return {
    identityPubkey: owner,
    registeredDevices: [
      { identityPubkey: owner, createdAt: 90 },
      { identityPubkey: device, createdAt: 100 },
    ],
    isCurrentDeviceRegistered: true,
    appKeysManagerReady: true,
    sessionManagerReady: true,
    hasLocalAppKeys: true,
    lastEventTimestamp: 100,
    ...overrides,
  }
}

function message(id: string, createdAt: number, body = id): DeviceSyncMessage {
  return { chatId: 'peer', id, body, author: owner, createdAt }
}

function snapshot(messages: DeviceSyncMessage[]): DeviceSyncSnapshot {
  return { v: 1, type: 'snapshot', rosterAt: 100, appKeys: [], chats: [], groups: [], messages }
}

function appKeys(
  ownerPubkey: string,
  createdAt: number,
  devicePubkey = ownerPubkey,
): DeviceSyncAppKeys {
  return {
    ownerPubkey,
    createdAt,
    devices: [{ identityPubkey: devicePubkey, createdAt: createdAt - 1 }],
  }
}

describe('device sync', () => {
  it('ignores legacy description fields while preserving local names and removed-device state', () => {
    const current = new AppKeys([{ identityPubkey: device, createdAt: 90 }])
    current.setDeviceLabels(device, { deviceLabel: 'Old name' }, 110)
    const merged = mergeDeviceDescriptions({ ownerPubkey: owner, createdAt: 100, devices: [
      { identityPubkey: device, createdAt: 90, deviceLabel: 'Study laptop', clientLabel: 'Iris Chat macOS', labelUpdatedAt: 200 },
      { identityPubkey: unrelatedOwner, createdAt: 90, deviceLabel: 'Removed device', labelUpdatedAt: 201 },
    ] }, { createdAt: 150, appKeys: current })
    expect(merged.createdAt).toBe(150)
    expect(merged.appKeys.getAllDevices()).toEqual(current.getAllDevices())
    expect(merged.appKeys.getDeviceLabels(device)?.deviceLabel).toBe('Old name')
  })

  it('includes mute and pin settings predating the new device without requiring history', async () => {
    await clearChatMutes()
    const until = Math.floor(Date.now() / 1000) + 3600
    const chatMutesState = [
      { chatId: peerOwner, untilSecs: until, updatedAtMs: Date.now() - 1000 },
      { chatId: 'group:friends', untilSecs: 0, updatedAtMs: 1 },
    ]
    await clearChatPins()
    const pins = [{ chatId: peerOwner, pinned: true, updatedAtMs: 1 }, { chatId: 'group:friends', pinned: false, updatedAtMs: 2 }]
    const packets = buildDeviceSyncReplyPackets({
      requestRosterAt: Math.floor(Date.now() / 1000), localRosterAt: 100, ownerPubkey: owner,
      appKeys: [], chats: [], groups: [], groupMessages: new Map(), chatMutes: chatMutesState, chatPins: pins,
    })
    const packet = packets.find(packet => packet.type === 'snapshot')!
    expect(packet).toMatchObject({ chatMutes: chatMutesState, chatPins: pins })
    if (packet.type !== 'snapshot') throw new Error('Expected metadata snapshot')
    await applyDeviceSyncSnapshot(packet, owner)
    expect(get(chatMutes)).toEqual({ [peerOwner]: until, 'group:friends': 0 })
    expect([...get(pinnedChatIds)]).toEqual([peerOwner])
    await clearChatPins()
    await clearChatMutes()
  })

  beforeEach(() => {
    vi.mocked(get(nostrClient).runtime.addSource).mockClear()
    fips.start.mockReset().mockResolvedValue(undefined)
    fips.nodes.length = 0
    fips.transports.length = 0
    ndr.knownSnapshots = []
    ndr.applyTrustedAppKeysSnapshot.mockClear()
    tcp.instances.length = 0
  })

  it('uses shared STUN-assisted FIPS defaults with public message servers configured', async () => {
    startDeviceSync(owner, new Uint8Array(32))
    try {
      for (let tick = 0; tick < 60 && tcp.instances.length === 0; tick++) await Promise.resolve()
      expect(fips.transports).toHaveLength(1)
      expect(fips.transports[0]).toMatchObject({
        relays: ['wss://relay.example'],
        stunServers: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
        ordered: false,
        maxRetransmits: 0,
      })
      expect(fips.transports[0]).not.toHaveProperty('iceGatherTimeoutMs')
      await vi.waitFor(() => expect(get(nostrClient).runtime.addSource)
        .toHaveBeenCalledWith(expect.objectContaining({ id: 'fips' })))
    } finally { await stopDeviceSync() }
  })

  it('keeps one node while the same device state is emitted during startup', async () => {
    let finishStart!: () => void
    fips.start.mockImplementationOnce(() => new Promise<void>(resolve => { finishStart = resolve }))
    startDeviceSync(owner, new Uint8Array(32))
    try {
      await vi.waitFor(() => expect(fips.nodes).toHaveLength(1))
      for (let update = 0; update < 6; update++) {
        ;(devices as unknown as Writable<DeviceState>).update(state => ({ ...state }))
      }
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(fips.nodes).toHaveLength(1)
      finishStart()
      await vi.waitFor(() => expect(get(nostrClient).runtime.addSource)
        .toHaveBeenCalledWith(expect.objectContaining({ id: 'fips' })))
    } finally {
      finishStart?.()
      await stopDeviceSync()
    }
  })

  it('prefers only current authorized siblings and removes their priority when revoked', async () => {
    const original = get(devices)
    startDeviceSync(owner, new Uint8Array(32))
    try {
      await vi.waitFor(() => expect(fips.transports).toHaveLength(1))
      expect(fips.transports[0].preferredAutoConnectPeers).toEqual([`02${'b'.repeat(64)}`, `03${'b'.repeat(64)}`])
      ;(devices as unknown as Writable<DeviceState>).update(state => ({
        ...state,
        lastEventTimestamp: state.lastEventTimestamp + 1,
        registeredDevices: state.registeredDevices.filter(device => device.identityPubkey === state.identityPubkey),
      }))
      await vi.waitFor(() => expect(fips.transports).toHaveLength(2))
      expect(fips.nodes[0].stop).toHaveBeenCalledOnce()
      expect(fips.transports[1].preferredAutoConnectPeers).toEqual([])
      expect((fips.transports[1].allowIncomingPeer as (peer: string) => boolean)(`02${'b'.repeat(64)}`)).toBe(false)
    } finally {
      await stopDeviceSync()
      ;(devices as unknown as Writable<DeviceState>).set(original)
    }
  })

  it('preserves an active history connection when the same roster is republished', async () => {
    const original = get(devices)
    startDeviceSync(owner, new Uint8Array(32))
    try {
      await vi.waitFor(() => expect(get(nostrClient).runtime.addSource).toHaveBeenCalled())
      const connection = tcp.instances[0]
      ;(devices as unknown as Writable<DeviceState>).update(state => ({
        ...state, lastEventTimestamp: state.lastEventTimestamp + 30,
      }))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(fips.nodes).toHaveLength(1)
      expect(fips.nodes[0].stop).not.toHaveBeenCalled()
      expect(connection.dispose).not.toHaveBeenCalled()
      connection.onConnected?.(`02${device}`)
      await vi.waitFor(() => expect(connection.sendFirst).toHaveBeenCalled())
      const requests = connection.sendFirst.mock.calls.map(([, payload]: [string, Uint8Array]) =>
        JSON.parse(new TextDecoder().decode(payload)))
      expect(requests).toContainEqual(expect.objectContaining({ type: 'request', rosterAt: original.lastEventTimestamp + 30 }))
    } finally {
      await stopDeviceSync()
      ;(devices as unknown as Writable<DeviceState>).set(original)
    }
  })

  it('keeps an in-flight startup when only the roster publication time advances', async () => {
    const original = get(devices)
    let finishStart!: () => void
    fips.start.mockImplementationOnce(() => new Promise<void>(resolve => { finishStart = resolve }))
    startDeviceSync(owner, new Uint8Array(32))
    try {
      await vi.waitFor(() => expect(fips.nodes).toHaveLength(1))
      ;(devices as unknown as Writable<DeviceState>).update(state => ({
        ...state, lastEventTimestamp: state.lastEventTimestamp + 30,
      }))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(fips.nodes).toHaveLength(1)
      expect(fips.nodes[0].stop).not.toHaveBeenCalled()
      finishStart()
      await vi.waitFor(() => expect(get(nostrClient).runtime.addSource).toHaveBeenCalled())
    } finally {
      finishStart?.()
      await stopDeviceSync()
      ;(devices as unknown as Writable<DeviceState>).set(original)
    }
  })

  it('restarts history connections when a device is authorized with a new joining time', async () => {
    const original = get(devices)
    startDeviceSync(owner, new Uint8Array(32))
    try {
      await vi.waitFor(() => expect(get(nostrClient).runtime.addSource).toHaveBeenCalled())
      ;(devices as unknown as Writable<DeviceState>).update(state => ({
        ...state, registeredDevices: state.registeredDevices.map(entry =>
          entry.identityPubkey === device ? { ...entry, createdAt: entry.createdAt + 30 } : entry),
      }))
      await vi.waitFor(() => expect(fips.nodes).toHaveLength(2))
      expect(fips.nodes[0].stop).toHaveBeenCalledOnce()
      expect(tcp.instances[0].dispose).toHaveBeenCalledOnce()
    } finally {
      await stopDeviceSync()
      ;(devices as unknown as Writable<DeviceState>).set(original)
    }
  })

  it('cancels an in-flight startup when the device is removed from the roster', async () => {
    let finishStart!: () => void
    fips.start.mockImplementationOnce(() => new Promise<void>(resolve => { finishStart = resolve }))
    const original = get(devices)
    startDeviceSync(owner, new Uint8Array(32))
    try {
      await vi.waitFor(() => expect(fips.nodes).toHaveLength(1))
      ;(devices as unknown as Writable<DeviceState>).update(state => ({ ...state, isCurrentDeviceRegistered: false }))
      finishStart()
      await vi.waitFor(() => expect(fips.nodes[0].stop).toHaveBeenCalledOnce())
      expect(get(nostrClient).runtime.addSource).not.toHaveBeenCalled()
    } finally {
      finishStart?.()
      await stopDeviceSync()
      ;(devices as unknown as Writable<DeviceState>).set(original)
    }
  })

  it('disposes a failed startup before a later state update can retry', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fips.start.mockRejectedValueOnce(new Error('test advert unavailable'))
    startDeviceSync(owner, new Uint8Array(32))
    try {
      await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(
        '[deviceSync] Runtime start failed:', expect.any(Error)))
      expect(fips.nodes[0].stop).toHaveBeenCalledOnce()
      expect(tcp.instances[0].dispose).toHaveBeenCalledOnce()
      ;(devices as unknown as Writable<DeviceState>).update(state => ({ ...state }))
      await vi.waitFor(() => expect(fips.nodes).toHaveLength(2))
    } finally {
      await stopDeviceSync()
      warning.mockRestore()
    }
  })

  it('accepts only authenticated devices on the active roster', () => {
    expect(isAuthorizedDeviceSyncSource(`02${device}`, deviceState())).toBe(true)
    expect(isAuthorizedDeviceSyncSource(`02${owner}`, deviceState())).toBe(false)
    expect(isAuthorizedDeviceSyncSource(`03${'c'.repeat(64)}`, deviceState())).toBe(false)
    expect(isAuthorizedDeviceSyncSource(`02${device}`, deviceState({ isCurrentDeviceRegistered: false }))).toBe(false)
  })

  it('syncs messages at or after both roster cutoffs', () => {
    const chat: ChatSession = {
      id: 'peer',
      recipientPubkey: 'peer',
      mode: 'manager',
      messages: [100, 101, 102].map((createdAt) => ({
        id: `${createdAt}`,
        content: `${createdAt}`,
        timestamp: createdAt * 1000,
        isMine: true,
      })),
    }
    const packets = buildDeviceSyncSnapshots({
      requestRosterAt: 100,
      localRosterAt: 101,
      ownerPubkey: owner,
      appKeys: [],
      chats: [chat],
      groups: [],
      groupMessages: new Map(),
    })

    expect(packets.flatMap((packet) => packet.messages).map(({ id }) => id)).toEqual(['101', '102'])
    expect(packets[0].rosterAt).toBe(101)
  })

  it('keeps call history local and rejects remote IDs in its reserved namespace', () => {
    const chat: ChatSession = { id: 'peer', recipientPubkey: 'peer', mode: 'manager', messages: [
      { id: 'call:local', content: 'Missed voice call', timestamp: 100_000, isMine: false },
      { id: 'normal', content: 'hello', timestamp: 100_000, isMine: false },
    ] }
    const sent = buildDeviceSyncSnapshots({ requestRosterAt: 1, localRosterAt: 1,
      ownerPubkey: owner, appKeys: [], chats: [chat], groups: [], groupMessages: new Map(),
    }).flatMap(packet => packet.messages)
    expect(sent.map(m => m.id)).toEqual(['normal'])
    const additions = selectDeviceSyncAdditions(snapshot([message('call:forged', 100), message('normal', 100)]), {
      rosterAt: 1, chatIds: new Set(), groupVersions: new Map(), messageIds: new Set(),
    })
    expect(additions.messages.map(m => m.id)).toEqual(['normal'])
  })

  it('does not send or apply expired messages', () => {
    vi.useFakeTimers()
    vi.setSystemTime(200_000)
    try {
      const chat: ChatSession = {
        id: peerOwner,
        recipientPubkey: peerOwner,
        mode: 'manager',
        messages: [
          { id: 'expired', content: 'old', timestamp: 100_000, isMine: true, expiresAt: 200 },
          { id: 'live', content: 'new', timestamp: 100_000, isMine: true, expiresAt: 201 },
        ],
      }
      const sent = buildDeviceSyncSnapshots({
        requestRosterAt: 100,
        localRosterAt: 100,
        ownerPubkey: owner,
        appKeys: [],
        chats: [chat],
        groups: [],
        groupMessages: new Map(),
      }).flatMap((packet) => packet.messages)
      expect(sent.map(({ id }) => id)).toEqual(['live'])

      const additions = selectDeviceSyncAdditions(snapshot([
        { ...message('expired', 100), expiresAt: 200 },
        { ...message('live', 100), expiresAt: 201 },
      ]), {
        rosterAt: 100,
        chatIds: new Set(),
        groupVersions: new Map(),
        messageIds: new Set(),
      })
      expect(additions.messages.map(({ id }) => id)).toEqual(['live'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('deduplicates received IDs and remains idempotent after merge', () => {
    const packet = snapshot([
      message('one', 101),
      message('one', 101),
      { ...message('one', 101), chatId: 'other-chat' },
      message('old', 100),
    ])
    const empty = {
      rosterAt: 100,
      chatIds: new Set<string>(),
      groupVersions: new Map(),
      messageIds: new Set<string>(),
    }
    const first = selectDeviceSyncAdditions(packet, empty)
    expect(first.messages.map(({ chatId, id }) => [chatId, id])).toEqual([
      ['peer', 'one'],
      ['peer', 'old'],
    ])
    expect(selectDeviceSyncAdditions(packet, {
      ...empty,
      messageIds: new Set(first.messages.map((item) => item.id)),
    }).messages).toEqual([])
  })

  it('accepts removed-group snapshots from authorized siblings but rejects malformed snapshots', () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
    const validGroup = {
      id: 'group-id',
      name: 'Friends',
      createdBy: owner,
      members: [owner],
      admins: [owner],
      revision: 1,
      createdAt: 100,
      updatedAt: 101,
    }
    expect(parseDeviceSyncPacket(encode({
      v: 1,
      type: 'snapshot',
      rosterAt: 100,
      chats: [],
      groups: [validGroup],
      messages: [],
    }), owner)).toMatchObject({ type: 'snapshot', appKeys: [] })
    expect(parseDeviceSyncPacket(encode({
      v: 1,
      type: 'snapshot',
      rosterAt: 100,
      chats: [],
      groups: [{ ...validGroup, members: [device], admins: [device] }],
      messages: [],
    }), owner)).toMatchObject({ groups: [{ members: [device] }] })
    expect(() => parseDeviceSyncPacket(encode({
      v: 1,
      type: 'snapshot',
      rosterAt: 100,
      appKeys: [{ ...appKeys(peerOwner, 100), ownerPubkey: 'invalid' }],
      chats: [],
      groups: [],
      messages: [],
    }), owner)).toThrow()
    expect(() => parseDeviceSyncPacket(encode({
      v: 1,
      type: 'snapshot',
      rosterAt: 100,
      appKeys: null,
      chats: [],
      groups: [],
      messages: [],
    }), owner)).toThrow()
    expect(() => parseDeviceSyncPacket(encode({
      v: 1,
      type: 'snapshot',
      rosterAt: 100,
      appKeys: [{
        ...appKeys(peerOwner, 100, device),
        devices: [
          { identityPubkey: device, createdAt: 90 },
          { identityPubkey: device.toUpperCase(), createdAt: 91 },
        ],
      }],
      chats: [],
      groups: [],
      messages: [],
    }), owner)).toThrow()
  })

  it('syncs AppKeys only for the owner, direct peers, and group members', () => {
    const packets = buildDeviceSyncSnapshots({
      requestRosterAt: 100,
      localRosterAt: 100,
      ownerPubkey: owner,
      appKeys: [
        appKeys(unrelatedOwner, 50),
        appKeys(groupMember, 40),
        appKeys(peerOwner, 20, device),
        appKeys(owner, 30),
        appKeys(peerOwner, 10, owner),
      ],
      chats: [{
        id: peerOwner,
        recipientPubkey: peerOwner,
        mode: 'manager',
        messages: [],
      }],
      groups: [{
        id: 'group-id',
        name: 'Friends',
        members: [owner, groupMember],
        admins: [owner],
        createdAt: 1_000,
      }],
      groupMessages: new Map(),
    })

    expect(packets.flatMap((packet) => packet.appKeys)).toEqual([
      appKeys(owner, 30),
      appKeys(peerOwner, 20, device),
      appKeys(groupMember, 40),
    ])
  })

  it('applies received AppKeys through the NDR runtime', async () => {
    const incoming = appKeys(peerOwner, 101, device)

    await applyDeviceSyncSnapshot({
      ...snapshot([]),
      appKeys: [incoming],
    }, owner)

    expect(ndr.applyTrustedAppKeysSnapshot).toHaveBeenCalledTimes(1)
    expect(ndr.applyTrustedAppKeysSnapshot.mock.calls[0]?.[0]).toMatchObject({
      ownerPubkey: peerOwner,
      createdAt: 101,
    })
    expect(ndr.applyTrustedAppKeysSnapshot.mock.calls[0]?.[0].appKeys).toBeInstanceOf(AppKeys)
    expect(ndr.applyTrustedAppKeysSnapshot.mock.calls[0]?.[0].appKeys.getAllDevices()).toEqual(
      incoming.devices,
    )
  })

  it('imports direct contacts without turning native group chat rows into direct sessions', async () => {
    await applyDeviceSyncSnapshot({
      ...snapshot([]),
      chats: [{ id: peerOwner, updatedAt: 101 }, { id: 'group:friends', updatedAt: 101 }],
    }, owner)
    expect([...get(chats).keys()]).toEqual([peerOwner])
    const { saveSession } = await import('./storage')
    expect(saveSession).toHaveBeenCalledTimes(1)
    expect(saveSession).toHaveBeenCalledWith(expect.objectContaining({ id: peerOwner }))
  })

  it('applies only a newer group roster version and preserves its local secret', async () => {
    const groupId = 'group-id'
    const groupStore = groups as unknown as Writable<Map<string, Group>>
    groupStore.set(new Map([[groupId, {
      id: groupId,
      name: 'Old name',
      members: [owner, device],
      admins: [owner],
      createdAt: 80_000,
      secret: 'local-only',
    }]]))
    groupRoster.set(groupId, { revision: 1, updatedAt: 100 })
    const wireGroup = buildDeviceSyncSnapshots({
      requestRosterAt: 100,
      localRosterAt: 100,
      ownerPubkey: owner,
      appKeys: [],
      chats: [],
      groups: [get(groupStore).get(groupId)!],
      groupMessages: new Map(),
    })[0].groups[0]
    expect(wireGroup.protocol).toBe('sender_key_v1')
    expect(wireGroup).not.toHaveProperty('secret')
    const packet: DeviceSyncSnapshot = {
      v: 1,
      type: 'snapshot',
      rosterAt: 100,
      appKeys: [],
      chats: [],
      groups: [{
        id: groupId,
        name: 'New name',
        createdBy: owner,
        members: [owner, device],
        admins: [owner],
        revision: 2,
        createdAt: 80,
        updatedAt: 101,
      }],
      messages: [],
    }

    await applyDeviceSyncSnapshot(packet, owner)
    expect(get(groupStore).get(groupId)).toMatchObject({
      name: 'New name',
      secret: 'local-only',
    })
    await applyDeviceSyncSnapshot({
      ...packet,
      groups: [{ ...packet.groups[0], name: 'Stale name', revision: 1, updatedAt: 999 }],
    }, owner)
    expect(get(groupStore).get(groupId)?.name).toBe('New name')
    expect(groupRoster.get(groupId)).toEqual({ revision: 2, updatedAt: 101 })
  })

  it.each(['sender_key_v1', 'pairwise_fanout_v1'] as const)('preserves %s when a secret-free group is synced back to its source', async (protocol: 'sender_key_v1' | 'pairwise_fanout_v1') => {
    const group = { id: `protocol-roundtrip-${protocol}`, name: 'Linked group', createdBy: owner,
      members: [owner, peerOwner], admins: [owner], revision: 1, createdAt: 80, updatedAt: 100, protocol }
    await applyDeviceSyncSnapshot({ ...snapshot([]), groups: [group] }, owner)
    const { saveGroup } = await import('./storage')
    expect(saveGroup).toHaveBeenCalledWith(expect.objectContaining({ id: group.id, protocol }))
    const restored = JSON.parse(JSON.stringify(get(groups).get(group.id)))
    const echoed = buildDeviceSyncSnapshots({ requestRosterAt: 100, localRosterAt: 100, ownerPubkey: owner,
      appKeys: [], chats: [], groups: [restored], groupMessages: new Map() })[0].groups[0]
    expect(echoed.protocol).toBe(protocol)
    expect(echoed).not.toHaveProperty('secret')
    await applyDeviceSyncSnapshot({ ...snapshot([]), groups: [{ ...group, revision: 0,
      protocol: protocol === 'sender_key_v1' ? 'pairwise_fanout_v1' : 'sender_key_v1' }] }, owner)
    expect(get(groups).get(group.id)?.protocol).toBe(protocol)
  })

  it('retains known removed chats from sibling snapshots and ignores stale reactivation or unknown removed groups', async () => {
    const groupId = 'removed-sibling-group'
    groups.set(new Map([[groupId, { id: groupId, name: 'History', members: [owner, device], admins: [device], createdAt: 80000, accepted: true }]]))
    const packet: DeviceSyncSnapshot = { ...snapshot([]), groups: [{
      id: groupId, name: 'History', members: [device], admins: [device], createdBy: device,
      revision: 2, createdAt: 80, updatedAt: 101,
    }] }
    await applyDeviceSyncSnapshot(packet, owner)
    expect(get(groups).get(groupId)?.members).toEqual([device])
    expect(get(groups).get(groupId)?.rosterVersion?.revision).toBe(2)
    await applyDeviceSyncSnapshot({ ...packet, groups: [
      { ...packet.groups[0], revision: 1, updatedAt: 999, members: [device, owner] },
      { ...packet.groups[0], id: 'unknown-removed' },
    ] }, owner)
    expect(get(groups).get(groupId)?.members).toEqual([device])
    expect(get(groups).has('unknown-removed')).toBe(false)
  })

  it('bootstraps legacy group expiry only for a new group without a local choice', async () => {
    groups.set(new Map()); expirationStore.clear()
    const group = { id: 'ttl-friends', name: 'Friends', createdBy: owner, members: [owner, peerOwner], admins: [owner], revision: 1, createdAt: 10, updatedAt: 20, legacyMessageTtlSeconds: 60 }
    const packet = { ...snapshot([]), groups: [group] }
    await applyDeviceSyncSnapshot(packet, owner)
    expect(expirationStore.getExpiration(group.id)).toBe(60)
    await applyDeviceSyncSnapshot({ ...packet, groups: [{ ...group, revision: 2, legacyMessageTtlSeconds: null }] }, owner)
    expect(expirationStore.getExpiration(group.id)).toBe(60)
    groups.set(new Map()); expirationStore.setExpiration(group.id, 3600)
    await applyDeviceSyncSnapshot(packet, owner)
    expect(expirationStore.getExpiration(group.id)).toBe(3600)
    expirationStore.clear()
  })

  it('chunks snapshots into self-contained bounded packets', () => {
    const chat: ChatSession = {
      id: 'peer',
      recipientPubkey: 'peer',
      mode: 'manager',
      messages: Array.from({ length: 12 }, (_, index) => ({
        id: `${index}`,
        content: 'x'.repeat(220),
        timestamp: (101 + index) * 1000,
        isMine: true,
      })),
    }
    const packets = buildDeviceSyncSnapshots({
      requestRosterAt: 100,
      localRosterAt: 100,
      ownerPubkey: owner,
      appKeys: [appKeys(owner, 100)],
      chats: [chat],
      groups: [] as Group[],
      groupMessages: new Map(),
    }, 1024)

    expect(packets.length).toBeGreaterThan(1)
    for (const packet of packets) {
      expect(packet).toMatchObject({ v: 1, type: 'snapshot', rosterAt: 100 })
      expect(encodeDeviceSyncPacket(packet).byteLength).toBeLessThanOrEqual(1024)
    }
    expect(packets.flatMap((packet) => packet.messages)).toHaveLength(12)
    expect(packets.flatMap((packet) => packet.appKeys)).toEqual([appKeys(owner, 100)])
  })

  it('fails an oversized snapshot item instead of reporting a truncated success', () => {
    const chat: ChatSession = {
      id: 'peer',
      recipientPubkey: 'peer',
      mode: 'manager',
      messages: [{
        id: 'oversized',
        content: 'x'.repeat(2_048),
        timestamp: 101_000,
        isMine: true,
      }],
    }
    expect(() => buildDeviceSyncSnapshots({
      requestRosterAt: 100,
      localRosterAt: 100,
      ownerPubkey: owner,
      appKeys: [],
      chats: [chat],
      groups: [] as Group[],
      groupMessages: new Map(),
    }, 512)).toThrow(/snapshot messages entry exceeds the packet limit/)
  })

  it('paginates only metadata in bounded packets', () => {
    const chats = Array.from({ length: 96 }, (_, index) => {
      const id = index.toString(16).padStart(64, '0')
      return {
        id,
        recipientPubkey: id,
        mode: 'manager' as const,
        messages: index === 0
          ? Array.from({ length: 70 }, (_, messageIndex) => ({
              id: `message-${messageIndex.toString().padStart(3, '0')}`,
              content: `body-${messageIndex}`,
              timestamp: (100 + messageIndex) * 1000,
              isMine: true,
            }))
          : [],
      }
    })
    const source = {
      requestRosterAt: 100,
      localRosterAt: 100,
      ownerPubkey: owner,
      appKeys: [],
      chats,
      groups: [] as Group[],
      groupMessages: new Map<string, never[]>(),
    }

    const metadata = buildDeviceSyncReplyPackets(source, undefined, 256)
    expect(metadata.filter((packet) => packet.type === 'snapshot')).toHaveLength(
      DEVICE_SYNC_PAGE_PACKETS,
    )
    expect(metadata.at(-1)).toEqual({
      v: 1,
      type: 'pageEnd',
      rosterAt: 100,
      next: { kind: 'metadata', offset: DEVICE_SYNC_PAGE_PACKETS },
    })

  })

  it('continues PageEnd and ResyncRequired control packets without applying a snapshot', async () => {
    startDeviceSync(owner, new Uint8Array(32))
    try {
      for (let tick = 0; tick < 60 && tcp.instances.length === 0; tick += 1) await Promise.resolve()
      const transport = tcp.instances.at(-1)!
      const source = `02${device}`
      transport.sendFirst.mockClear()

      await transport.onRecord(source, encodeDeviceSyncPacket({
        v: 1,
        type: 'pageEnd',
        rosterAt: 100,
        next: { kind: 'metadata', offset: 32 },
      }))
      expect(transport.sendFirst).toHaveBeenLastCalledWith(source, encodeDeviceSyncPacket({
        v: 1,
        type: 'request',
        rosterAt: 100,
        recordReconcile: 1,
        page: { kind: 'metadata', offset: 32 },
      }))

      await transport.onRecord(source, encodeDeviceSyncPacket({ v: 1, type: 'resyncRequired' }))
      expect(transport.sendFirst).toHaveBeenLastCalledWith(source, encodeDeviceSyncPacket({
        v: 1,
        type: 'request',
        rosterAt: 100,
        recordReconcile: 1,
      }))

      transport.send.mockRejectedValueOnce(new Error('queue full'))
      await expect(transport.onRecord(source, encodeDeviceSyncPacket({
        v: 1,
        type: 'request',
        rosterAt: 100,
        recordReconcile: 1,
      }))).rejects.toThrow('queue full')
      expect(transport.sendFirst).toHaveBeenLastCalledWith(
        source,
        encodeDeviceSyncPacket({ v: 1, type: 'resyncRequired' }),
      )

      await expect(transport.onRecord(
        source,
        new TextEncoder().encode('{"v":1,"type":"snapshot"'),
      )).rejects.toThrow(/valid UTF-8 JSON/)
      expect(ndr.applyTrustedAppKeysSnapshot).not.toHaveBeenCalled()
    } finally {
      await stopDeviceSync()
    }
  })

  it('keeps an advertised history demand valid across a new metadata request', async () => {
    const stored = { id: 'pending-history', sessionId: peerOwner, content: 'Still available', timestamp: 110_000, isMine: true }
    const { db } = await import('./storage')
    const read = vi.spyOn(db.messages, 'get').mockResolvedValue(stored as never)
    chats.set(new Map([[peerOwner, { id: peerOwner, recipientPubkey: peerOwner, mode: 'manager', messages: [stored] }]]))
    groups.set(new Map())
    startDeviceSync(owner, new Uint8Array(32))
    try {
      for (let tick = 0; tick < 60 && tcp.instances.length === 0; tick++) await Promise.resolve()
      const transport = tcp.instances.at(-1)!, source = `02${device}`, session = '1'.repeat(32)
      const request = encodeDeviceSyncPacket({ v: 1, type: 'request', rosterAt: 100, recordReconcile: 1 })
      await transport.onRecord(source, request)
      const frame = bytesToHex(await new Reconciliation([], { since: 100n, until: 200n }).initiate())
      await transport.onRecord(source, encodeDeviceSyncPacket({ v: 1, type: 'historyOpen', scope: 'history', session, since: 100, until: 200, frame }))
      expect(transport.send.mock.calls.map((call: unknown[]) => parseDeviceSyncPacket(call[1] as Uint8Array, owner)))
        .toContainEqual(expect.objectContaining({ type: 'historyFrame', session }))
      // A fresh metadata request can arrive after the inventory but before its demand.
      await transport.onRecord(source, request)
      transport.send.mockClear()
      const id = historyRecordId({ chatId: peerOwner, id: stored.id })
      await transport.onRecord(source, encodeDeviceSyncPacket({ v: 1, type: 'historyNeed', session, ids: [id] }))
      expect(transport.send.mock.calls.map((call: unknown[]) => parseDeviceSyncPacket(call[1] as Uint8Array, owner))).toEqual([
        expect.objectContaining({ type: 'historyRecords', session, records: [expect.objectContaining({ type: 'message', message: expect.objectContaining({ id: stored.id, body: stored.content }) })] }),
        { v: 1, type: 'historyRecords', session, records: [], requested: [id] },
      ])
    } finally { read.mockRestore(); await stopDeviceSync() }
  })

  it.each([false, true])('accepts only the exact approving pair history window after a reciprocal metadata reply: %s', async (reciprocalReply: boolean) => {
    chats.set(new Map())
    groups.set(new Map())
    startDeviceSync(owner, new Uint8Array(32))
    try {
      for (let tick = 0; tick < 60 && tcp.instances.length === 0; tick++) await Promise.resolve()
      const transport = tcp.instances.at(-1)!, source = `02${device}`, linkId = '8'.repeat(64)
      await saveDeviceHistoryPair(owner, owner, { peer: device, linkId, linkAt: 100, since: 0, role: 'outbound', complete: false })
      await transport.onRecord(source, encodeDeviceSyncPacket({ v: 1, type: 'request', rosterAt: 0, recordReconcile: 1 }))
      if (reciprocalReply) await transport.onRecord(source, encodeDeviceSyncPacket({ v: 1, type: 'pageEnd', rosterAt: 100, next: null, recordReconcile: 1 }))
      transport.send.mockClear()
      const frame = bytesToHex(await new Reconciliation([], { since: 0n, until: 99n }).initiate())
      const open = { v: 1 as const, type: 'historyOpen' as const, scope: 'history' as const, session: '1'.repeat(32), since: 0, until: 99, frame }
      await transport.onRecord(source, encodeDeviceSyncPacket({ ...open, linkId: '9'.repeat(64) }))
      expect(transport.send).not.toHaveBeenCalled()
      await transport.onRecord(source, encodeDeviceSyncPacket({ ...open, linkId }))
      expect(transport.send.mock.calls.map((call: unknown[]) => parseDeviceSyncPacket(call[1] as Uint8Array, owner))).toEqual([expect.objectContaining({ type: 'historyFrame' })])
    } finally { await stopDeviceSync() }
  })

  it('never lowers the ordinary live-message floor to a newer sibling supplied cutoff', async () => {
    chats.set(new Map())
    startDeviceSync(owner, new Uint8Array(32))
    try {
      for (let tick = 0; tick < 60 && tcp.instances.length === 0; tick++) await Promise.resolve()
      const transport = tcp.instances.at(-1)!, source = `02${device}`
      await saveDeviceHistoryPair(owner, owner, { peer: device, linkId: '7'.repeat(64), linkAt: 100, since: 0, role: 'outbound', complete: false })
      await transport.onRecord(source, encodeDeviceSyncPacket({ ...snapshot([]), rosterAt: 0, messages: [
        { chatId: peerOwner, id: 'old-unauthorized', body: 'Old', author: owner, createdAt: 95 },
        { chatId: peerOwner, id: 'live-authorized', body: 'Live', author: owner, createdAt: 110 },
      ] }))
      expect(get(chats).get(peerOwner)?.messages.map(message => message.id)).toEqual(['live-authorized'])
    } finally { await stopDeviceSync() }
  })

  it('pushes new chat metadata without replaying history', async () => {
    vi.useFakeTimers()
    try {
      startDeviceSync(owner, new Uint8Array(32))
      for (let tick = 0; tick < 60 && tcp.instances.length === 0; tick += 1) {
        await Promise.resolve()
      }
      const node = fips.nodes.at(-1)
      expect(node).toBeDefined()
      node?.emit('peer', {
        state: 'connected',
        remotePubkey: `02${device}`,
        remoteAddr: { transport: 'webrtc', addr: 'peer' },
      })
      const transport = tcp.instances.at(-1)
      expect(transport).toBeDefined()
      expect(DEVICE_SYNC_PORT).toBe(7369)
      expect(transport?.port).toBe(DEVICE_SYNC_PORT)
      transport?.send.mockClear()

      const chatId = 'c'.repeat(64)
      const historyChatId = 'd'.repeat(64)
      ;(chats as unknown as Writable<Map<string, ChatSession>>).set(new Map([
        [chatId, {
          id: chatId,
          recipientPubkey: chatId,
          mode: 'manager',
          messages: [],
        }],
        [historyChatId, {
          id: historyChatId,
          recipientPubkey: historyChatId,
          mode: 'manager',
          messages: [{ id: 'history', content: 'old', timestamp: 101_000, isMine: true }],
        }],
      ]))
      ndr.knownSnapshots = [{
        ownerPubkey: owner,
        createdAt: 100,
        appKeys: new AppKeys([{ identityPubkey: device, createdAt: 99 }]),
      }]
      await vi.advanceTimersByTimeAsync(101)

      const packet = JSON.parse(new TextDecoder().decode(
        transport?.send.mock.calls[0]?.[1],
      )) as DeviceSyncSnapshot
      expect(packet.chats).toContainEqual({ id: chatId, updatedAt: 0 })
      expect(packet.appKeys).toEqual([appKeys(owner, 100, device)])
      expect(packet.messages).toEqual([])
    } finally {
      await stopDeviceSync()
      vi.useRealTimers()
    }
  })
})

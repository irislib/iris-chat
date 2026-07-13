import { get, writable } from 'svelte/store'
import type { Writable } from 'svelte/store'
import { describe, expect, it, vi } from 'vitest'
import type { ChatSession } from './chat'
import type { DeviceState } from './devices'
import type { Group } from './groups'

const fips = vi.hoisted(() => ({
  nodes: [] as Array<{ emit: (event: string, value: unknown) => void }>,
  sendDatagram: vi.fn(async () => undefined),
}))
const groupRoster = vi.hoisted(() =>
  new Map<string, { revision: number; updatedAt: number }>()
)

vi.mock('@fips/core', () => ({
  FipsNode: class {
    private listeners = new Map<string, (value: unknown) => void>()
    constructor() { fips.nodes.push(this) }
    registerService() {}
    on(event: string, listener: (value: unknown) => void) { this.listeners.set(event, listener) }
    emit(event: string, value: unknown) { this.listeners.get(event)?.(value) }
    start = vi.fn(async () => undefined)
    stop = vi.fn(async () => undefined)
    sendDatagram = fips.sendDatagram
  },
  identityFromSecretKey: vi.fn(async () => ({ xOnlyPubkey: new Uint8Array(32) })),
  toHex: vi.fn(() => 'a'.repeat(64)),
}))
vi.mock('@fips/transport-webrtc', () => ({ WebRtcTransport: class {} }))
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
vi.mock('./identity', () => ({ getPubkey: vi.fn(() => 'a'.repeat(64)) }))
vi.mock('./relayStore', () => ({
  relayStore: { getState: () => ({ relays: new Set(['wss://relay.example']) }) },
}))
vi.mock('./storage', () => ({
  saveGroup: vi.fn(),
  saveMessage: vi.fn(),
  saveSession: vi.fn(),
}))

import {
  buildDeviceSyncSnapshots,
  applyDeviceSyncSnapshot,
  isAuthorizedDeviceSyncSource,
  parseDeviceSyncPacket,
  selectDeviceSyncAdditions,
  startDeviceSync,
  stopDeviceSync,
  type DeviceSyncMessage,
  type DeviceSyncSnapshot,
} from './deviceSync'
import { chats } from './chat'
import { groups } from './groups'

const owner = 'a'.repeat(64)
const device = 'b'.repeat(64)

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
  return { v: 1, type: 'snapshot', rosterAt: 100, chats: [], groups: [], messages }
}

describe('device sync', () => {
  it('accepts only authenticated devices on the active roster', () => {
    expect(isAuthorizedDeviceSyncSource(`02${device}`, deviceState())).toBe(true)
    expect(isAuthorizedDeviceSyncSource(`02${owner}`, deviceState())).toBe(false)
    expect(isAuthorizedDeviceSyncSource(`03${'c'.repeat(64)}`, deviceState())).toBe(false)
    expect(isAuthorizedDeviceSyncSource(`02${device}`, deviceState({ isCurrentDeviceRegistered: false }))).toBe(false)
  })

  it('syncs only messages strictly newer than both roster cutoffs', () => {
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
      chats: [chat],
      groups: [],
      groupMessages: new Map(),
    })

    expect(packets.flatMap((packet) => packet.messages).map(({ id }) => id)).toEqual(['102'])
    expect(packets[0].rosterAt).toBe(101)
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
    ])
    expect(selectDeviceSyncAdditions(packet, {
      ...empty,
      messageIds: new Set(first.messages.map((item) => item.id)),
    }).messages).toEqual([])
  })

  it('rejects malformed snapshots and groups that exclude the local owner', () => {
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
    }), owner)?.type).toBe('snapshot')
    expect(parseDeviceSyncPacket(encode({
      v: 1,
      type: 'snapshot',
      rosterAt: 100,
      chats: [],
      groups: [{ ...validGroup, members: [device], admins: [device] }],
      messages: [],
    }), owner)).toBeNull()
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
      chats: [chat],
      groups: [] as Group[],
      groupMessages: new Map(),
    }, 1024)

    expect(packets.length).toBeGreaterThan(1)
    for (const packet of packets) {
      expect(packet).toMatchObject({ v: 1, type: 'snapshot', rosterAt: 100 })
      expect(new TextEncoder().encode(JSON.stringify(packet)).byteLength).toBeLessThanOrEqual(1024)
    }
    expect(packets.flatMap((packet) => packet.messages)).toHaveLength(12)
  })

  it('pushes new chat metadata without replaying history', async () => {
    vi.useFakeTimers()
    try {
      startDeviceSync(owner, new Uint8Array(32))
      for (let tick = 0; tick < 10 && fips.nodes.length === 0; tick += 1) {
        await Promise.resolve()
      }
      const node = fips.nodes.at(-1)
      expect(node).toBeDefined()
      node?.emit('peer', {
        state: 'connected',
        remotePubkey: `02${device}`,
        remoteAddr: { transport: 'webrtc', addr: 'peer' },
      })
      fips.sendDatagram.mockClear()

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
      await vi.advanceTimersByTimeAsync(101)

      const packet = JSON.parse(new TextDecoder().decode(
        fips.sendDatagram.mock.calls[0]?.[0].payload,
      )) as DeviceSyncSnapshot
      expect(packet.chats).toContainEqual({ id: chatId, updatedAt: 0 })
      expect(packet.messages).toEqual([])
    } finally {
      await stopDeviceSync()
      vi.useRealTimers()
    }
  })
})

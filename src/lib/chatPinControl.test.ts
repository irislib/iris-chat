import 'fake-indexeddb/auto'
import { get, writable, type Writable } from 'svelte/store'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getEventHash } from 'nostr-tools'
import type { Rumor } from 'nostr-double-ratchet'

const owner = 'a'.repeat(64)
const sibling = 'b'.repeat(64)
const local = 'c'.repeat(64)
const peer = 'd'.repeat(64)
const transport = vi.hoisted(() => ({ sendEvent: vi.fn(async () => undefined) }))
vi.mock('./identity', () => ({
  identity: writable({ pubkey: 'a'.repeat(64) }),
  getPubkey: () => 'a'.repeat(64),
}))
vi.mock('./devices', () => ({ devices: writable({
  identityPubkey: 'c'.repeat(64), isCurrentDeviceRegistered: true,
  registeredDevices: ['b', 'c'].map(key => ({ identityPubkey: key.repeat(64), createdAt: 1 })),
}) }))
vi.mock('./privateChats', () => ({ waitForNdrRuntime: async () => transport }))
vi.mock('./notifications', () => ({ updateDMSubscription: vi.fn(async () => {}) }))

import { pinnedChatIds, chatPinStates, clearChatPins, loadChatPins, setChatPinned } from './chatPinStore'
import { CHAT_PIN_KIND } from './chatPinSync'
import { receiveChatPinControl } from './chatPinControl'
import { clearAllData } from './storage'
import { devices, type DeviceState } from './devices'
const deviceStore = devices as unknown as Writable<DeviceState>

beforeEach(() => {
  deviceStore.update(state => ({ ...state, isCurrentDeviceRegistered: true }))
})
afterEach(async () => {
  await clearChatPins()
  await clearAllData()
  vi.clearAllMocks()
})

function rumor(pinned: boolean, updatedAtMs = Date.now()): Rumor {
  const event = {
    pubkey: owner, kind: CHAT_PIN_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['p', owner]],
    content: JSON.stringify({ type: 'chat-pin', v: 1, pin: { chatId: peer, pinned, updatedAtMs } }),
  }
  return { ...event, id: getEventHash(event) }
}
const meta = { senderOwnerPubkey: owner, senderDevicePubkey: sibling }

it('sends a complete control only to the account, never to the pinned contact', async () => {
  await setChatPinned(peer, true)
  await vi.waitFor(() => expect(transport.sendEvent).toHaveBeenCalledTimes(1))
  const [recipient, event] = vi.mocked(transport.sendEvent).mock.calls[0] as unknown as [string, Rumor]
  expect(recipient).toBe(owner)
  expect(event.tags).toEqual([['p', owner]])
  expect(event.kind).toBe(CHAT_PIN_KIND)
  expect(event.id).toBe(getEventHash(event))
  expect(JSON.parse(event.content).pin.pinned).toBe(get(pinnedChatIds).has(peer))
})

it('receives an offline change, persists unpin against stale replay', async () => {
  const at = Date.now()
  await receiveChatPinControl(rumor(true, at), meta)
  expect(get(pinnedChatIds).has(peer)).toBe(true)
  await receiveChatPinControl(rumor(false, at + 1), meta)
  await loadChatPins(null)
  await loadChatPins(owner)
  await receiveChatPinControl(rumor(true, at), meta)
  expect(get(pinnedChatIds).has(peer)).toBe(false)
  expect(get(chatPinStates)[peer].pinned).toBe(false)
  expect(transport.sendEvent).not.toHaveBeenCalled()
})

it('rejects contact, unknown-device, and removed-device control messages', async () => {
  for (const sender of [undefined,
    { senderOwnerPubkey: peer, senderDevicePubkey: sibling },
    { senderOwnerPubkey: owner, senderDevicePubkey: peer },
    { senderOwnerPubkey: owner, senderDevicePubkey: local },
  ]) await receiveChatPinControl(rumor(true), sender)
  expect(get(pinnedChatIds).size).toBe(0)
  deviceStore.update(state => ({ ...state, isCurrentDeviceRegistered: false }))
  await receiveChatPinControl(rumor(true), meta)
  expect(get(pinnedChatIds).size).toBe(0)
})


it('keeps rapid pin then unpin in order and does not leak state across accounts', async () => {
  await Promise.all([setChatPinned(peer, true), setChatPinned(peer, false)])
  expect(get(pinnedChatIds).has(peer)).toBe(false)
  const latest = get(chatPinStates)[peer]
  expect(latest.pinned).toBe(false)
  await loadChatPins(null)
  expect(get(pinnedChatIds).size).toBe(0)
  await loadChatPins(owner)
  expect(get(chatPinStates)[peer]).toEqual(latest)
})

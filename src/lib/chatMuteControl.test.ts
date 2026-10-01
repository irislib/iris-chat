import 'fake-indexeddb/auto'
import { get, writable, type Writable } from 'svelte/store'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getEventHash } from 'nostr-tools'
import type { Rumor } from 'nostr-double-ratchet'

const owner = 'a'.repeat(64)
const sibling = 'b'.repeat(64)
const local = 'c'.repeat(64)
const peer = 'd'.repeat(64)
const transport = vi.hoisted(() => ({ sendEvent: vi.fn(async (_owner: string, event: Rumor): Promise<Rumor | undefined> => event) }))
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

import { chatMutes, chatMuteStates, clearChatMutes, loadChatMutes, mergeChatMutes, setChatMute } from './chatMuteStore'
import { CHAT_MUTE_KIND } from './chatMuteSync'
import { receiveChatMuteControl, startChatMuteSync } from './chatMuteControl'
import { clearAllData } from './storage'
import { devices, type DeviceState } from './devices'
const deviceStore = devices as unknown as Writable<DeviceState>

beforeEach(() => {
  deviceStore.update(state => ({ ...state, isCurrentDeviceRegistered: true }))
})
afterEach(async () => {
  await clearChatMutes()
  await clearAllData()
  vi.clearAllMocks()
})

function rumor(untilSecs: number | null, updatedAtMs = Date.now()): Rumor {
  const event = {
    pubkey: owner, kind: CHAT_MUTE_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['p', owner]],
    content: JSON.stringify({ type: 'chat-mute', v: 1, mute: { chatId: peer, untilSecs, updatedAtMs } }),
  }
  return { ...event, id: getEventHash(event) }
}
const meta = { senderOwnerPubkey: owner, senderDevicePubkey: sibling }

it('sends a complete control only to the account, never to the muted contact', async () => {
  await setChatMute(peer, 3600)
  await vi.waitFor(() => expect(transport.sendEvent).toHaveBeenCalledTimes(1))
  const [recipient, event] = vi.mocked(transport.sendEvent).mock.calls[0] as unknown as [string, Rumor]
  expect(recipient).toBe(owner)
  expect(event.tags).toEqual([['p', owner]])
  expect(event.kind).toBe(CHAT_MUTE_KIND)
  expect(event.id).toBe(getEventHash(event))
  expect(JSON.parse(event.content).mute.untilSecs).toBe(get(chatMutes)[peer])
})

it('receives an offline change, preserves the deadline, and persists unmute against stale replay', async () => {
  const at = Date.now()
  const until = Math.floor(at / 1000) + 3600
  await receiveChatMuteControl(rumor(until, at), meta)
  expect(get(chatMutes)[peer]).toBe(until)
  await receiveChatMuteControl(rumor(null, at + 1), meta)
  await loadChatMutes(null)
  await loadChatMutes(owner)
  await receiveChatMuteControl(rumor(until, at), meta)
  expect(get(chatMutes)[peer]).toBeUndefined()
  expect(get(chatMuteStates)[peer].untilSecs).toBeNull()
  expect(transport.sendEvent).not.toHaveBeenCalled()
})

it('rejects contact, unknown-device, and removed-device control messages', async () => {
  for (const sender of [undefined,
    { senderOwnerPubkey: peer, senderDevicePubkey: sibling },
    { senderOwnerPubkey: owner, senderDevicePubkey: peer },
    { senderOwnerPubkey: owner, senderDevicePubkey: local },
  ]) await receiveChatMuteControl(rumor(0), sender)
  expect(get(chatMutes)).toEqual({})
  deviceStore.update(state => ({ ...state, isCurrentDeviceRegistered: false }))
  await receiveChatMuteControl(rumor(0), meta)
  expect(get(chatMutes)).toEqual({})
})

it('converges concurrent changes and keeps expired deadlines as revisions', async () => {
  const at = Date.now()
  const timed = { chatId: peer, untilSecs: Math.floor(at / 1000) - 1, updatedAtMs: at }
  const forever = { ...timed, untilSecs: 0 }
  await mergeChatMutes([timed, forever], owner)
  expect(get(chatMuteStates)[peer]).toEqual(timed)
  expect(get(chatMutes)).toEqual({})
  await clearChatMutes()
  await mergeChatMutes([forever, timed], owner)
  expect(get(chatMuteStates)[peer]).toEqual(timed)
  expect(get(chatMutes)).toEqual({})
  await mergeChatMutes([{ ...forever, updatedAtMs: at + 600_000 }], owner)
  expect(get(chatMuteStates)[peer]).toEqual(timed)
})

it('replays persisted timed mutes and unmute tombstones after restart and a failed handoff', async () => {
  const deadline = Math.floor(Date.now() / 1000) + 3600
  await mergeChatMutes([{ chatId: peer, untilSecs: deadline, updatedAtMs: Date.now() },
    { chatId: 'group:cleared', untilSecs: null, updatedAtMs: Date.now() }], owner)
  await loadChatMutes(null)
  transport.sendEvent.mockResolvedValueOnce(undefined)
  const stop = startChatMuteSync(owner)
  try {
    await vi.waitFor(() => expect(transport.sendEvent).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 0))
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(transport.sendEvent).toHaveBeenCalledTimes(3))
    const controls = transport.sendEvent.mock.calls.slice(1).map(([, event]: [string, Rumor]) => JSON.parse(event.content).mute)
    expect(controls).toEqual(expect.arrayContaining([
      expect.objectContaining({ chatId: peer, untilSecs: deadline }),
      expect.objectContaining({ chatId: 'group:cleared', untilSecs: null }),
    ]))
    expect(transport.sendEvent.mock.calls.every(([target]: [string, Rumor]) => target === owner)).toBe(true)
  } finally { stop() }
})

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { get, writable } from 'svelte/store'
vi.mock('./identity', () => ({ identity: writable<{ pubkey: string } | null>(null) }))
vi.mock('./notifications', () => ({ updateDMSubscription: vi.fn(async () => {}) }))
import { identity } from './identity'
import { clearAllData, getSessionManagerValue, listSessionManagerKeys, putSessionManagerValue } from './storage'
import { chatMutes, loadChatMutes, setChatMute, clearChatMutes } from './chatMuteStore'
import { chatMutesKey, isChatMuted } from './chatMutePolicy'
import { updateDMSubscription } from './notifications'

beforeEach(() => { identity.set({ pubkey: 'profile', displayName: null, isNip07: false }) })
afterEach(async () => { await clearChatMutes(); await clearAllData(); identity.set(null); vi.useRealTimers(); vi.clearAllMocks() })

it('persists deadlines, restores them, and unmuting one chat preserves another indefinite mute', async () => {
  await setChatMute('alice', 3600)
  await setChatMute('bob', 0)
  const stored = await getSessionManagerValue(chatMutesKey('profile'))
  await loadChatMutes(null)
  await loadChatMutes('profile')
  expect(get(chatMutes)).toEqual(stored)
  await setChatMute('alice', null)
  expect(get(chatMutes)).toEqual({ bob: 0 })
  expect(isChatMuted(get(chatMutes), 'bob')).toBe(true)
})

it('expiry refreshes server subscriptions without unmuting an indefinite chat', async () => {
  const now = Math.floor(Date.now() / 1000)
  await putSessionManagerValue(chatMutesKey('profile'), { alice: now + 1, bob: 0 })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(now * 1000)
  await loadChatMutes('profile')
  expect(get(chatMutes).alice).toBe(now + 1)
  await vi.advanceTimersByTimeAsync(1000)
  expect(get(chatMutes)).toEqual({ bob: 0 })
  expect(updateDMSubscription).toHaveBeenCalled()
})

it('logout invalidates a pending load/write before database cleanup and isolates a new profile', async () => {
  const pending = setChatMute('alice', 3600)
  await clearChatMutes()
  identity.set(null)
  await clearAllData()
  await pending
  expect(await listSessionManagerKeys()).toEqual([])
  identity.set({ pubkey: 'new-profile', displayName: null, isNip07: false })
  await loadChatMutes('new-profile')
  expect(get(chatMutes)).toEqual({})
})

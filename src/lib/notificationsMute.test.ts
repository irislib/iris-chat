import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { writable } from 'svelte/store'
const fixture = vi.hoisted(() => ({ supported: true, requests: [] as Record<string, unknown>[], authors: new Map() }))
vi.mock('./identity', () => ({ identity: writable(null), ndk: writable({ signer: {} }) }))
vi.mock('./chat', () => ({ getInviteEphemeralPubkeys: () => [] }))
vi.mock('./privateChats', () => ({ getNdrRuntime: () => ({ getSessionUserRecords: () => fixture.authors }) }))
vi.mock('./notificationPermission', () => ({ getNotificationSupportError: () => null, requestNotificationPermission: async () => ({ permission: 'granted' }) }))
vi.mock('@nostr-dev-kit/ndk', () => ({ NDKEvent: class { async sign() {} async toNostrEvent() { return {} } } }))
import { identity } from './identity'
import { notificationSettings } from './notificationStore'
import { subscribeToDMNotifications } from './notifications'
import { setChatMute, clearChatMutes } from './chatMuteStore'
import { clearAllData } from './storage'

beforeEach(() => {
  fixture.requests = []
  fixture.supported = true
  fixture.authors = new Map(['alice', 'bob'].map(owner => [owner, { devices: new Map([['device', {
    activeSession: { state: { theirCurrentNostrPublicKey: `${owner}-current`, theirNextNostrPublicKey: `${owner}-next` } }, inactiveSessions: [],
  }]]) }]))
  identity.set({ pubkey: 'profile', displayName: null, isNip07: false })
  notificationSettings.setEnabled(false)
  vi.stubGlobal('Notification', { permission: 'granted' })
  vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve({ pushManager: {
    getSubscription: async () => ({ endpoint: 'https://push.invalid/device', options: {}, getKey: () => new ArrayBuffer(2) }),
  } }) } })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/info')) return new Response(JSON.stringify({ vapid_public_key: 'AQID', supports_timed_filters: fixture.supported }))
    if (init?.method === 'POST') {
      fixture.requests.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ id: 'messages' }))
    }
    return new Response(JSON.stringify({ messages: { filter: { kinds: [1060], authors: ['alice-current', 'bob-current'] },
      web_push_subscriptions: [{ endpoint: 'https://push.invalid/device' }], subscriber: 'profile' } }))
  }))
})
afterEach(async () => { notificationSettings.setEnabled(false); await clearChatMutes(); await clearAllData(); identity.set(null); vi.unstubAllGlobals() })

it('production subscription builder delays every muted ratchet author while retaining other chats', async () => {
  await setChatMute('alice', 3600)
  expect((await subscribeToDMNotifications()).success).toBe(true)
  const filters = fixture.requests.at(-1)?.filters as Array<{ authors: string[]; since?: number }>
  expect(filters[0]).toEqual({ kinds: [1060], authors: ['bob-current', 'bob-next'] })
  expect(filters[1].authors).toEqual(['alice-current', 'alice-next'])
  expect(filters[1].since).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3590)
})
it('production subscription update conservatively excludes timed authors on a legacy server', async () => {
  fixture.supported = false
  await setChatMute('alice', 3600)
  expect((await subscribeToDMNotifications()).success).toBe(true)
  expect(fixture.requests.at(-1)?.filters).toEqual([{ kinds: [1060], authors: ['bob-current', 'bob-next'] }])
})
it('muting every chat replaces the old subscription with an empty author list, never a wildcard', async () => {
  await setChatMute('alice', 0)
  await setChatMute('bob', 0)
  expect((await subscribeToDMNotifications()).success).toBe(true)
  expect(fixture.requests.at(-1)?.filter).toEqual({ kinds: [1060], authors: [] })
  expect(fixture.requests.at(-1)?.filters).toEqual([{ kinds: [1060], authors: [] }])
})

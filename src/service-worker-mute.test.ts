import 'fake-indexeddb/auto'
import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest'
import { Session } from 'nostr-double-ratchet'
import { getPublicKey,type Event } from 'nostr-tools'
import { clearAllData, putSessionManagerValue, saveProcessedEvent, saveProfileToStorage } from './lib/storage'
import { chatMutesKey } from './lib/chatMutePolicy'

const handlers = new Map<string, (event: unknown) => void>()
const showNotification = vi.fn(async () => {})
const key=(n:number)=>new Uint8Array(32).fill(n)
const person=getPublicKey(key(2))
let signedPush:Event
beforeAll(async () => {
  vi.stubGlobal('self', { registration: { scope: 'https://chat.invalid/', showNotification },
    clients: { matchAll: async () => [] }, addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler) })
  await import('./service-worker')
})
beforeEach(async () => {
  showNotification.mockClear()
  await putSessionManagerValue('v1/device-manager/owner-pubkey', 'profile')
  signedPush=Session.init(getPublicKey(key(5)),key(4),true,key(6)).sendEvent({kind:14,pubkey:person,content:'Hello',tags:[]}).event
  await saveProcessedEvent({ id: signedPush.id, kind: 14, chatId: person, content: 'Hello', timestamp: Date.now() })
})
afterEach(clearAllData)
async function receivePush() {
  let pending: Promise<void> | undefined
  handlers.get('push')!({ data: { json: () => JSON.parse(JSON.stringify({event:signedPush})) },
    waitUntil: (promise: Promise<void>) => { pending = promise } })
  await pending
}
it('background worker honors persisted mute without a running app or foreground timer', async () => {
  await putSessionManagerValue(chatMutesKey('profile'), { [person]: Math.floor(Date.now() / 1000) + 3600 })
  await receivePush()
  expect(showNotification).not.toHaveBeenCalled()
})
it('background worker resumes at expiry and ignores an unrelated muted chat', async () => {
  await putSessionManagerValue(chatMutesKey('profile'), { [person]: Math.floor(Date.now() / 1000), other: 0 })
  await receivePush()
  expect(showNotification).toHaveBeenCalledOnce()
  expect(showNotification.mock.calls[0]).toEqual(expect.arrayContaining([expect.any(String), expect.objectContaining({ body: 'Hello' })]))
})

it('notifications keep the locally accepted name while the public profile has changed', async () => {
  await saveProfileToStorage({ pubkey: person, name: 'Alicia Updated', updatedAt: Date.now() })
  await putSessionManagerValue(`iris-contact-memory:v1:profile:${person}`, {
    first_seen_name: 'Alice Original', accepted_name: 'Alice Original', favorite: false, name_changes: [],
  })
  await receivePush()
  expect(showNotification.mock.calls[0]).toEqual(expect.arrayContaining(['Alice Original', expect.objectContaining({ body: 'Hello' })]))
  showNotification.mockClear()
  await putSessionManagerValue('v1/device-manager/owner-pubkey', 'other-account')
  await receivePush()
  expect(showNotification.mock.calls[0]).toEqual(expect.arrayContaining(['Alicia Updated', expect.objectContaining({ body: 'Hello' })]))
})

it('a group cache entry cannot admit a raw push or silence that member’s direct chat', async () => {
  await putSessionManagerValue(chatMutesKey('profile'), { 'group:test': Math.floor(Date.now() / 1000) + 3600 })
  await saveProcessedEvent({ id: signedPush.id, kind: 14, chatId: 'group:test', content: 'Group hello', timestamp: Date.now() })
  await receivePush()
  expect(showNotification).not.toHaveBeenCalled()

  await saveProcessedEvent({ id: signedPush.id, kind: 14, chatId: person, content: 'Direct hello', timestamp: Date.now() })
  await receivePush()
  expect(showNotification).toHaveBeenCalledOnce()
  expect(showNotification.mock.calls[0]).toEqual(expect.arrayContaining([expect.any(String), expect.objectContaining({ body: 'Direct hello' })]))
})

import 'fake-indexeddb/auto'
import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest'
import { clearAllData, putSessionManagerValue, saveProcessedEvent } from './lib/storage'
import { chatMutesKey } from './lib/chatMutePolicy'

const handlers = new Map<string, (event: unknown) => void>()
const showNotification = vi.fn(async () => {})
beforeAll(async () => {
  vi.stubGlobal('self', { registration: { scope: 'https://chat.invalid/', showNotification },
    clients: { matchAll: async () => [] }, addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler) })
  await import('./service-worker')
})
beforeEach(async () => {
  showNotification.mockClear()
  await putSessionManagerValue('v1/device-manager/owner-pubkey', 'profile')
  await saveProcessedEvent({ id: '1'.repeat(64), kind: 14, chatId: 'a'.repeat(64), content: 'Hello', timestamp: Date.now() })
})
afterEach(clearAllData)
async function receivePush() {
  let pending: Promise<void> | undefined
  handlers.get('push')!({ data: { json: () => ({ event: { id: '1'.repeat(64), pubkey: 'b'.repeat(64), created_at: 100, kind: 1060, tags: [], content: '', sig: '2'.repeat(128) } }) },
    waitUntil: (promise: Promise<void>) => { pending = promise } })
  await pending
}
it('background worker honors persisted mute without a running app or foreground timer', async () => {
  await putSessionManagerValue(chatMutesKey('profile'), { ['a'.repeat(64)]: Math.floor(Date.now() / 1000) + 3600 })
  await receivePush()
  expect(showNotification).not.toHaveBeenCalled()
})
it('background worker resumes at expiry and ignores an unrelated muted chat', async () => {
  await putSessionManagerValue(chatMutesKey('profile'), { ['a'.repeat(64)]: Math.floor(Date.now() / 1000), other: 0 })
  await receivePush()
  expect(showNotification).toHaveBeenCalledOnce()
  expect(showNotification.mock.calls[0]).toEqual(expect.arrayContaining([expect.any(String), expect.objectContaining({ body: 'Hello' })]))
})

it('group mute suppresses an identified group without silencing that member’s direct chat', async () => {
  await putSessionManagerValue(chatMutesKey('profile'), { 'group:test': Math.floor(Date.now() / 1000) + 3600 })
  await saveProcessedEvent({ id: '1'.repeat(64), kind: 14, chatId: 'group:test', content: 'Group hello', timestamp: Date.now() })
  await receivePush()
  expect(showNotification).not.toHaveBeenCalled()

  await saveProcessedEvent({ id: '1'.repeat(64), kind: 14, chatId: 'a'.repeat(64), content: 'Direct hello', timestamp: Date.now() })
  await receivePush()
  expect(showNotification).toHaveBeenCalledOnce()
  expect(showNotification.mock.calls[0]).toEqual(expect.arrayContaining([expect.any(String), expect.objectContaining({ body: 'Direct hello' })]))
})

import 'fake-indexeddb/auto'
import { beforeEach, expect, it, vi } from 'vitest'
import { db } from './storage'
import { writeNameApproval } from './privateStateControl'
import { contactPrivateEvents } from './privateStateStore'

const account = vi.hoisted(() => ({ owner: 'a'.repeat(64), device: 'b'.repeat(64) }))
const send = vi.hoisted(() => vi.fn())
vi.mock('./identity', () => ({ getPubkey: () => account.owner }))
vi.mock('./privateChats', () => ({ waitForNdrRuntime: async () => ({
  getState: () => ({ ownerPubkey: account.owner, currentDevicePubkey: account.device }), sendEvent: send,
}) }))
vi.mock('./devices', async () => ({ devices: (await import('svelte/store')).writable({ isCurrentDeviceRegistered: false }) }))
beforeEach(async () => {
  await db.sessionManager.clear(); localStorage.clear(); send.mockClear()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_key: string, callback: () => Promise<void>) => callback() } })
})
it('saves an unsigned local name approval while registration is offline, keeping transmission pending', async () => {
  const contact = 'c'.repeat(64)
  await writeNameApproval(account.owner, contact, 'Alice', { previous_name:'Alice', accepted_name:'Alicia', accepted_at_secs:Math.floor(Date.now()/1000) })
  const events = await contactPrivateEvents(account.owner, contact, 10455)
  expect(events).toHaveLength(1)
  expect(events[0].pubkey).toBe(account.device)
  expect('sig' in events[0]).toBe(false)
  expect(JSON.parse(localStorage.getItem(`iris-contact-memory:v1:${account.owner}:${contact}`)!)).toMatchObject({ accepted_name:'Alicia' })
  expect(await db.sessionManager.get(`private-state-pending:${account.owner}:${events[0].id}`)).toBeDefined()
  expect(send).not.toHaveBeenCalled()
})

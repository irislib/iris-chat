import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { DexieStorageAdapter } from './sessionManagerStorage'
import { clearAllData } from './storage'
import * as storage from './storage'

afterEach(async () => { vi.restoreAllMocks(); await clearAllData() })

it('late callbacks from a logged-out runtime cannot recreate data or access a new profile', async () => {
  const old = new DexieStorageAdapter()
  await old.put('session', { privateState: 'old profile' })
  const pendingRead = old.get('session')
  old.close()
  await clearAllData()
  expect(await pendingRead).toBeUndefined()
  await old.put('late-roster', { privateState: 'old profile' })
  const current = new DexieStorageAdapter()
  expect(await current.list()).toEqual([])
  await current.put('session', { privateState: 'new profile' })
  expect(await old.get('session')).toBeUndefined()
  expect(await old.list()).toEqual([])
  await old.del('session')
  expect(await current.get('session')).toEqual({ privateState: 'new profile' })
})


it('quiesces an already-started write before account erasure and rejects later writes', async () => {
  const actualPut = storage.putSessionManagerValue
  let finish!: () => void
  let started!: () => void
  const waiting = new Promise<void>(resolve => { finish = resolve })
  const entered = new Promise<void>(resolve => { started = resolve })
  vi.spyOn(storage, 'putSessionManagerValue').mockImplementationOnce(async (key, value) => {
    started()
    await waiting
    await actualPut(key, value)
  })
  const old = new DexieStorageAdapter()
  const pending = old.put('v1/broadcast-channel/group/old/consumed-outer/event', { privateState: 'old' })
  await entered
  let quiesced = false
  const closing = Promise.resolve(old.close()).then(() => { quiesced = true })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(quiesced).toBe(false)
  await old.put('late', { privateState: 'old' })
  finish()
  await Promise.all([pending, closing])
  await clearAllData()
  const current = new DexieStorageAdapter()
  await current.put('new', { privateState: 'new' })
  await old.put('late-again', { privateState: 'old' })
  expect(await current.list()).toEqual(['new'])
})

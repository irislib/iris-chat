import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import { DexieStorageAdapter } from './sessionManagerStorage'
import { clearAllData } from './storage'

afterEach(clearAllData)

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

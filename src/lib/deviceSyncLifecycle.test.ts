// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { createDeviceSyncLifecycle } from './deviceSyncLifecycle'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function page(target: EventTarget, type: string, persisted = false) {
  const event = new Event(type)
  Object.defineProperty(event, 'persisted', { value: persisted })
  target.dispatchEvent(event)
}
function fixture() {
  const target = new EventTarget(), start = vi.fn(), stop = vi.fn(async () => {})
  const state = { owner: 'alice' as string | null }
  const lifecycle = createDeviceSyncLifecycle(target, { currentOwner: () => state.owner, start, stop })
  return { target, start, stop, state, lifecycle }
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

it('starts shutdown synchronously and waits for it before one persisted pageshow restart', async () => {
  const f = fixture(), closing = deferred()
  await f.lifecycle.start('alice')
  f.stop.mockImplementationOnce(() => closing.promise)
  page(f.target, 'visibilitychange')
  expect(f.stop).not.toHaveBeenCalled()
  page(f.target, 'pagehide', true)
  expect(f.stop).toHaveBeenCalledOnce()
  page(f.target, 'pageshow', true); page(f.target, 'pageshow', true)
  await flush(); expect(f.start).toHaveBeenCalledTimes(1)
  closing.resolve(); await flush()
  expect(f.start.mock.calls).toEqual([['alice'], ['alice']])
  await f.lifecycle.dispose()
})

it('does not resurrect a logged-out or switched owner after deferred shutdown', async () => {
  for (const owner of [null, 'bob']) {
    const f = fixture(), closing = deferred()
    await f.lifecycle.start('alice')
    f.stop.mockImplementationOnce(() => closing.promise)
    page(f.target, 'pagehide', true); page(f.target, 'pageshow', true)
    f.state.owner = owner
    closing.resolve(); await flush()
    expect(f.start.mock.calls).toEqual([['alice']])
    await f.lifecycle.start('alice')
    expect(f.start).toHaveBeenCalledTimes(1)
    if (owner) { await f.lifecycle.start(owner); expect(f.start).toHaveBeenLastCalledWith('bob') }
    await f.lifecycle.dispose()
  }
})

it('holds asynchronous login readiness while hidden and ignores a stale restore after another hide', async () => {
  const f = fixture(), closing = deferred()
  f.stop.mockImplementationOnce(() => closing.promise)
  page(f.target, 'pagehide', true)
  const ready = f.lifecycle.start('alice')
  page(f.target, 'pageshow', true); page(f.target, 'pagehide', true)
  closing.resolve(); await ready; await flush()
  expect(f.start).not.toHaveBeenCalled()
  page(f.target, 'pageshow', false); await flush()
  expect(f.start).not.toHaveBeenCalled()
  page(f.target, 'pageshow', true); await flush()
  expect(f.start.mock.calls).toEqual([['alice']])
  await f.lifecycle.dispose()
})

it('stops an already-started asynchronous runtime immediately and never resumes after disposal', async () => {
  const f = fixture(), startup = deferred()
  let generation = 0, adopted = false
  f.start.mockImplementation(() => {
    const run = generation
    void startup.promise.then(() => { if (run === generation) adopted = true })
  })
  f.stop.mockImplementation(async () => { generation++ })
  await f.lifecycle.start('alice')
  page(f.target, 'pagehide', true)
  expect(generation).toBe(1)
  startup.resolve(); await flush(); expect(adopted).toBe(false)
  await f.lifecycle.dispose()
  page(f.target, 'pageshow', true); await f.lifecycle.start('alice')
  expect(f.start).toHaveBeenCalledOnce()
})

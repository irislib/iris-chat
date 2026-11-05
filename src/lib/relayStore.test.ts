import { afterEach, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

it.each([[], ['ws://127.0.0.1:1234'], ['wss://custom.example']].map(relays => ({ relays })))('preserves a saved relay selection $relays', async ({ relays }) => {
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(relays), setItem: vi.fn() })
  const { relayStore } = await import('./relayStore')
  expect([...get(relayStore).relays]).toEqual(relays)
})
it('uses defaults only when no saved setting exists', async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  const { relayStore, DEFAULT_RELAYS } = await import('./relayStore')
  expect([...get(relayStore).relays]).toEqual(DEFAULT_RELAYS)
})
it.each(['invalid JSON', '{"relays":[]}', '[42]'])('does not replace unreadable saved policy %s with public relays', async stored => {
  vi.stubGlobal('localStorage', { getItem: () => stored, setItem: vi.fn() })
  const { relayStore } = await import('./relayStore')
  expect([...get(relayStore).relays]).toEqual([])
})
it('keeps public relays disabled after storage read failure', async () => {
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('unavailable') }, setItem: vi.fn() })
  const { relayStore } = await import('./relayStore')
  expect([...get(relayStore).relays]).toEqual([])
})

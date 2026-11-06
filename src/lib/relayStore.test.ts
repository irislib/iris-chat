import { afterEach, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

it.each([[], ['ws://127.0.0.1:1234'], ['wss://custom.example']].map(relays => ({ relays })))('preserves a saved relay selection $relays', async ({ relays }: { relays: string[] }) => {
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(relays), setItem: vi.fn() })
  const { relayStore } = await import('./relayStore')
  expect([...get(relayStore).relays]).toEqual(relays)
  expect((await import('./relayStore')).getPublicRelays(get(relayStore))).toEqual(relays)
})
it('uses defaults only when no saved setting exists', async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  const { relayStore, DEFAULT_RELAYS } = await import('./relayStore')
  expect([...get(relayStore).relays]).toEqual(DEFAULT_RELAYS)
})
it.each(['invalid JSON', '{"relays":[]}', '[42]'])('does not replace unreadable saved policy %s with public relays', async (stored: string) => {
  vi.stubGlobal('localStorage', { getItem: () => stored, setItem: vi.fn() })
  const { relayStore } = await import('./relayStore')
  expect([...get(relayStore).relays]).toEqual([])
  expect((await import('./relayStore')).getPublicRelays(get(relayStore))).toEqual([])
})
it('keeps public relays disabled after storage read failure', async () => {
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('unavailable') }, setItem: vi.fn() })
  const { relayStore } = await import('./relayStore')
  expect([...get(relayStore).relays]).toEqual([])
  expect((await import('./relayStore')).getPublicRelays(get(relayStore))).toEqual([])
})

it('adds the public default without changing message servers, and revokes it on any saved choice', async () => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })
  const { relayStore, DEFAULT_RELAYS, getPublicRelays } = await import('./relayStore')
  expect([...get(relayStore).relays]).toEqual(DEFAULT_RELAYS)
  expect(getPublicRelays(get(relayStore))).toEqual(['wss://relay.ditto.pub', ...DEFAULT_RELAYS])
  relayStore.setRelays(new Set(DEFAULT_RELAYS))
  expect(getPublicRelays(get(relayStore))).toEqual(DEFAULT_RELAYS)
  vi.resetModules()
  const reloaded = await import('./relayStore')
  expect(reloaded.getPublicRelays(get(reloaded.relayStore))).toEqual(DEFAULT_RELAYS)
  reloaded.relayStore.setRelays(new Set())
  expect(reloaded.getPublicRelays(get(reloaded.relayStore))).toEqual([])
  reloaded.relayStore.resetToDefaults()
  expect(storage.has('iris-chat-relays')).toBe(false)
  expect(reloaded.getPublicRelays(get(reloaded.relayStore))[0]).toBe('wss://relay.ditto.pub')
  expect([...get(reloaded.relayStore).relays]).toEqual(DEFAULT_RELAYS)
})

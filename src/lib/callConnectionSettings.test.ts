import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

const storage = { getItem: vi.fn(), setItem: vi.fn() }
Object.defineProperty(globalThis, 'localStorage', { value: storage })

describe('call connection settings', () => {
  beforeEach(() => {
    vi.resetModules()
    storage.getItem.mockReset()
    storage.setItem.mockReset()
  })

  it('adds STUN to existing saved connections without replacing their FIPS nodes', async () => {
    storage.getItem.mockReturnValue(JSON.stringify({ servers: ['wss://local.example/fips'] }))
    const { callConnectionSettings } = await import('./callConnectionSettings')
    expect(get(callConnectionSettings)).toEqual({
      servers: ['wss://local.example/fips'],
      stunServers: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
    })
  })

  it('preserves explicit local-only STUN settings when saving FIPS nodes', async () => {
    storage.getItem.mockReturnValue(JSON.stringify({ servers: [], stunServers: [] }))
    const { callConnectionSettings, setCallServers } = await import('./callConnectionSettings')
    setCallServers('wss://local.example/fips')
    expect(get(callConnectionSettings).stunServers).toEqual([])
    expect(JSON.parse(storage.setItem.mock.calls.at(-1)![1])).toEqual({
      servers: ['wss://local.example/fips'], stunServers: [],
    })
  })

  it('keeps custom STUN addresses but excludes TURN and credential-bearing URLs', async () => {
    storage.getItem.mockReturnValue(JSON.stringify({
      servers: [],
      stunServers: ['stun:127.0.0.1:3478', 'turn:relay.example:3478', 'stun:user:secret@example.com', null],
    }))
    const { callConnectionSettings } = await import('./callConnectionSettings')
    expect(get(callConnectionSettings).stunServers).toEqual(['stun:127.0.0.1:3478'])
  })
})

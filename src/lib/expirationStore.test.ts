import { describe, it, expect, beforeEach, vi } from 'vitest'
import { get } from 'svelte/store'

// We need to reset the module for each test since expirationStore is
// a singleton that reads from localStorage on module load.

const store: Record<string, string> = {}
const localStorageMock = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { store[key] = value }),
  removeItem: vi.fn((key: string) => { delete store[key] }),
  clear: vi.fn(() => { for (const k of Object.keys(store)) delete store[k] }),
  key: vi.fn(),
  length: 0,
}
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true, configurable: true })

describe('expirationStore', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.resetModules()
  })

  it('starts empty when localStorage is empty', async () => {
    const { expirationStore } = await import('./expirationStore')
    const state = get(expirationStore)
    expect(state.expirations).toEqual({})
  })

  it('loads persisted expirations from localStorage', async () => {
    localStorage.setItem(
      'iris-chat-expirations',
      JSON.stringify({ expirations: { abc: 3600 } })
    )
    const { expirationStore } = await import('./expirationStore')
    const state = get(expirationStore)
    expect(state.expirations.abc).toBe(3600)
  })

  it('setExpiration stores a TTL for a chat', async () => {
    const { expirationStore } = await import('./expirationStore')
    expirationStore.setExpiration('chat1', 300)

    const state = get(expirationStore)
    expect(state.expirations.chat1).toBe(300)
  })

  it('setExpiration persists to localStorage', async () => {
    const { expirationStore } = await import('./expirationStore')
    expirationStore.setExpiration('chat1', 300)

    const raw = localStorage.getItem('iris-chat-expirations')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed.expirations.chat1).toBe(300)
  })

  it('setExpiration with null disables for that chat', async () => {
    const { expirationStore } = await import('./expirationStore')
    expirationStore.setExpiration('chat1', 300)
    expirationStore.setExpiration('chat1', null)

    const state = get(expirationStore)
    expect(state.expirations.chat1).toBeNull()
  })

  it('clearExpiration removes the chat entry entirely', async () => {
    const { expirationStore } = await import('./expirationStore')
    expirationStore.setExpiration('chat1', 300)
    expirationStore.clearExpiration('chat1')

    const state = get(expirationStore)
    expect(state.expirations.chat1).toBeUndefined()
    expect('chat1' in state.expirations).toBe(false)
  })

  it('getExpiration returns the current TTL', async () => {
    const { expirationStore } = await import('./expirationStore')
    expirationStore.setExpiration('chat1', 3600)

    expect(expirationStore.getExpiration('chat1')).toBe(3600)
  })

  it('getExpiration returns undefined for unknown chat', async () => {
    const { expirationStore } = await import('./expirationStore')
    expect(expirationStore.getExpiration('unknown')).toBeUndefined()
  })

  it('getAllExpirations returns all stored expirations', async () => {
    const { expirationStore } = await import('./expirationStore')
    expirationStore.setExpiration('chat1', 300)
    expirationStore.setExpiration('chat2', 3600)
    expirationStore.setExpiration('chat3', null)

    const all = expirationStore.getAllExpirations()
    expect(all).toEqual({
      chat1: 300,
      chat2: 3600,
      chat3: null,
    })
  })

  it('handles multiple independent chats', async () => {
    const { expirationStore } = await import('./expirationStore')
    expirationStore.setExpiration('chatA', 300)
    expirationStore.setExpiration('chatB', 86400)

    expect(expirationStore.getExpiration('chatA')).toBe(300)
    expect(expirationStore.getExpiration('chatB')).toBe(86400)

    expirationStore.clearExpiration('chatA')
    expect(expirationStore.getExpiration('chatA')).toBeUndefined()
    expect(expirationStore.getExpiration('chatB')).toBe(86400)
  })

  it('handles corrupt localStorage gracefully', async () => {
    localStorage.setItem('iris-chat-expirations', 'not-json')
    const { expirationStore } = await import('./expirationStore')
    const state = get(expirationStore)
    expect(state.expirations).toEqual({})
  })

  it('handles localStorage with missing expirations key', async () => {
    localStorage.setItem('iris-chat-expirations', JSON.stringify({ something: 'else' }))
    const { expirationStore } = await import('./expirationStore')
    const state = get(expirationStore)
    expect(state.expirations).toEqual({})
  })
})

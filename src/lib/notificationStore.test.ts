import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  key: vi.fn(),
  length: 0,
}
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock })

describe('notificationSettings', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorageMock.getItem.mockReset()
    localStorageMock.setItem.mockReset()
  })

  it('fills missing fields in saved settings from defaults', async () => {
    localStorageMock.getItem.mockReturnValueOnce(JSON.stringify({ declined: true }))

    const { notificationSettings } = await import('./notificationStore')

    expect(get(notificationSettings)).toEqual({
      enabled: false,
      serverUrl: 'https://notifications.iris.to',
      declined: true,
    })
  })

  it('persists field updates and reset', async () => {
    const { notificationSettings } = await import('./notificationStore')

    notificationSettings.setEnabled(true)
    notificationSettings.setServerUrl('https://push.example')
    notificationSettings.reset()

    expect(localStorageMock.setItem).toHaveBeenLastCalledWith(
      'iris-chat-notifications',
      JSON.stringify({
        enabled: false,
        serverUrl: 'https://notifications.iris.to',
        declined: false,
      }),
    )
  })
})

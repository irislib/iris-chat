import { afterEach, expect, it, vi } from 'vitest'
import { CallNotification } from './callNotification'
afterEach(() => vi.unstubAllGlobals())
const call = { id: 'first', name: 'Alex', video: true }
it('closes late OS delivery after answer, decline, timeout or cancellation', async () => {
  const close = vi.fn()
  let posted!: () => void
  const registration = { showNotification: vi.fn(() => new Promise<void>(resolve => { posted = resolve })),
    getNotifications: vi.fn(async () => [{ close }]) }
  vi.stubGlobal('Notification', { permission: 'granted' })
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => registration } })
  const alerts = new CallNotification()
  alerts.update(call); await vi.waitFor(() => expect(registration.showNotification).toHaveBeenCalledOnce())
  alerts.update(call); expect(registration.showNotification).toHaveBeenCalledOnce()
  alerts.clear(); await Promise.resolve(); close.mockClear()
  posted(); await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
})
it('never posts an alert canceled before service worker lookup returns', async () => {
  const showNotification = vi.fn()
  let ready!: (value: unknown) => void
  vi.stubGlobal('Notification', { permission: 'granted' })
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration: () => new Promise(resolve => { ready = resolve }) } })
  const alerts = new CallNotification()
  alerts.update(call); alerts.clear(); ready({ showNotification }); await Promise.resolve()
  expect(showNotification).not.toHaveBeenCalled()
})
it('closes desktop alerts on transition and respects denied permission', async () => {
  const close = vi.fn(), created = vi.fn()
  vi.stubGlobal('navigator', {})
  vi.stubGlobal('Notification', class { static permission = 'granted'; close = close; constructor() { created() } })
  const alerts = new CallNotification()
  alerts.update(call); await Promise.resolve(); expect(created).toHaveBeenCalledOnce()
  alerts.update(null); expect(close).toHaveBeenCalledOnce()
  Object.defineProperty(Notification, 'permission', { value: 'denied' })
  alerts.update(call); await Promise.resolve(); expect(created).toHaveBeenCalledOnce()
})

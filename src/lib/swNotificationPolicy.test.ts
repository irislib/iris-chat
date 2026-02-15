import { describe, it, expect } from 'vitest'
import {
  shouldShowInviteResponseNotification,
  shouldShowSystemNotificationForMessagePush,
} from './swNotificationPolicy'

describe('swNotificationPolicy', () => {
  it('suppresses invite-response notifications when any client is visible', () => {
    expect(shouldShowInviteResponseNotification({ anyVisibleClient: true })).toBe(false)
    expect(shouldShowInviteResponseNotification({ anyVisibleClient: false })).toBe(true)
  })

  it('suppresses message notifications when any client is visible', () => {
    expect(shouldShowSystemNotificationForMessagePush({ anyVisibleClient: true, silentEvent: false })).toBe(false)
  })

  it('suppresses message notifications for silent inner events', () => {
    expect(shouldShowSystemNotificationForMessagePush({ anyVisibleClient: false, silentEvent: true })).toBe(false)
  })

  it('shows message notifications only when no client is visible and event is not silent', () => {
    expect(shouldShowSystemNotificationForMessagePush({ anyVisibleClient: false, silentEvent: false })).toBe(true)
  })
})


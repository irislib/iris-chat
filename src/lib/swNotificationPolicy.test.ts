import { describe, it, expect } from 'vitest'
import {
  CHAT_MESSAGE_KIND,
  CHAT_SETTINGS_KIND,
  GROUP_INVITE_RUMOR_KIND,
  GROUP_METADATA_KIND,
  GROUP_SENDER_KEY_DISTRIBUTION_KIND,
  GROUP_SENDER_KEY_MESSAGE_KIND,
  REACTION_KIND,
  RECEIPT_KIND,
  TYPING_KIND,
} from 'nostr-double-ratchet'
import {
  isUserFacingInnerKind,
  shouldShowInviteResponseNotification,
} from './swNotificationPolicy'

describe('isUserFacingInnerKind', () => {
  it('treats chat messages and reactions as user-facing', () => {
    expect(isUserFacingInnerKind(CHAT_MESSAGE_KIND)).toBe(true)
    expect(isUserFacingInnerKind(REACTION_KIND)).toBe(true)
  })

  it('silences typing, receipts, and settings sync', () => {
    expect(isUserFacingInnerKind(TYPING_KIND)).toBe(false)
    expect(isUserFacingInnerKind(RECEIPT_KIND)).toBe(false)
    expect(isUserFacingInnerKind(CHAT_SETTINGS_KIND)).toBe(false)
  })

  it('silences group metadata, invite rumor, and key distribution kinds', () => {
    expect(isUserFacingInnerKind(GROUP_METADATA_KIND)).toBe(false)
    expect(isUserFacingInnerKind(GROUP_INVITE_RUMOR_KIND)).toBe(false)
    expect(isUserFacingInnerKind(GROUP_SENDER_KEY_DISTRIBUTION_KIND)).toBe(false)
    expect(isUserFacingInnerKind(GROUP_SENDER_KEY_MESSAGE_KIND)).toBe(false)
  })

  it('silences unknown future kinds by default (allowlist)', () => {
    expect(isUserFacingInnerKind(99999)).toBe(false)
    expect(isUserFacingInnerKind(0)).toBe(false)
  })
})

describe('shouldShowInviteResponseNotification', () => {
  it('skips when any client is visible (UA treats user as engaged)', () => {
    expect(shouldShowInviteResponseNotification({ anyVisibleClient: true })).toBe(false)
    expect(shouldShowInviteResponseNotification({ anyVisibleClient: false })).toBe(true)
  })
})

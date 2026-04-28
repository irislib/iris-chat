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
import { renderRumor } from './pushRumorRender'

describe('renderRumor', () => {
  it('renders chat messages as durable with their content', () => {
    expect(renderRumor(CHAT_MESSAGE_KIND, 'hello')).toEqual({ body: 'hello', durable: true })
  })

  it('falls back to "New message" for empty chat content', () => {
    expect(renderRumor(CHAT_MESSAGE_KIND, '')).toEqual({ body: 'New message', durable: true })
    expect(renderRumor(CHAT_MESSAGE_KIND, undefined)).toEqual({ body: 'New message', durable: true })
  })

  it('renders reactions with emoji and falls back when missing', () => {
    expect(renderRumor(REACTION_KIND, '❤️')).toEqual({ body: 'Reacted ❤️', durable: true })
    expect(renderRumor(REACTION_KIND, '')).toEqual({ body: 'Reacted', durable: true })
  })

  it('renders typing as ephemeral', () => {
    expect(renderRumor(TYPING_KIND, undefined)).toEqual({ body: 'is typing…', durable: false })
  })

  it('renders receipts based on delivered/seen content', () => {
    expect(renderRumor(RECEIPT_KIND, 'seen')).toEqual({ body: 'Read your message', durable: false })
    expect(renderRumor(RECEIPT_KIND, 'delivered')).toEqual({ body: 'Received your message', durable: false })
    expect(renderRumor(RECEIPT_KIND, undefined)).toEqual({ body: 'Status update', durable: false })
  })

  it('renders settings sync and group metadata as ephemeral', () => {
    expect(renderRumor(CHAT_SETTINGS_KIND, '{}')).toEqual({ body: 'Updated chat settings', durable: false })
    expect(renderRumor(GROUP_METADATA_KIND, '{}')).toEqual({ body: 'Updated group', durable: false })
  })

  it('renders group invites as durable', () => {
    expect(renderRumor(GROUP_INVITE_RUMOR_KIND, undefined)).toEqual({ body: 'Invited you to a group', durable: true })
  })

  it('skips internal group key plumbing', () => {
    expect(renderRumor(GROUP_SENDER_KEY_DISTRIBUTION_KIND, '...')).toBeNull()
    expect(renderRumor(GROUP_SENDER_KEY_MESSAGE_KIND, '...')).toBeNull()
  })

  it('skips unknown and missing kinds', () => {
    expect(renderRumor(99999, 'x')).toBeNull()
    expect(renderRumor(undefined, 'x')).toBeNull()
  })
})

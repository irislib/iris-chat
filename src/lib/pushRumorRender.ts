import {
  CHAT_MESSAGE_KIND,
  REACTION_KIND,
  RECEIPT_KIND,
  TYPING_KIND,
  CHAT_SETTINGS_KIND,
  GROUP_METADATA_KIND,
  GROUP_INVITE_RUMOR_KIND,
  GROUP_SENDER_KEY_DISTRIBUTION_KIND,
  GROUP_SENDER_KEY_MESSAGE_KIND,
} from 'nostr-double-ratchet'

export type RenderedRumor = {
  body: string
  // True for chat messages, reactions, group invites — durable activity that
  // warrants a sticky audible notification. False for ephemeral status
  // (typing, receipts, settings sync, group metadata) which should reuse a
  // shared tag so the latest replaces the previous one and the user isn't
  // pinged audibly.
  durable: boolean
}

// Decide what (if anything) the SW should display for a decrypted inner
// double-ratchet rumor. Returning null means "skip" — used for internal
// cryptographic plumbing (sender-key distribution/messages) and unknown
// kinds that have no meaningful user-facing description.
export function renderRumor(kind: number | undefined, content: string | undefined): RenderedRumor | null {
  switch (kind) {
    case CHAT_MESSAGE_KIND:
      return { body: content?.trim() || 'New message', durable: true }
    case REACTION_KIND: {
      const emoji = content?.trim()
      return { body: emoji ? `Reacted ${emoji}` : 'Reacted', durable: true }
    }
    case TYPING_KIND:
      return { body: 'is typing…', durable: false }
    case RECEIPT_KIND:
      if (content === 'seen') return { body: 'Read your message', durable: false }
      if (content === 'delivered') return { body: 'Received your message', durable: false }
      return { body: 'Status update', durable: false }
    case CHAT_SETTINGS_KIND:
      return { body: 'Updated chat settings', durable: false }
    case GROUP_METADATA_KIND:
      return { body: 'Updated group', durable: false }
    case GROUP_INVITE_RUMOR_KIND:
      return { body: 'Invited you to a group', durable: true }
    case GROUP_SENDER_KEY_DISTRIBUTION_KIND:
    case GROUP_SENDER_KEY_MESSAGE_KIND:
      // Internal cryptographic plumbing — nothing meaningful to show.
      return null
    default:
      return null
  }
}

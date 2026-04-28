import {
  CHAT_MESSAGE_KIND,
  REACTION_KIND,
} from 'nostr-double-ratchet'

// Inner double-ratchet rumor kinds that should produce a system notification.
// Web push cannot be suppressed server-side, so the SW must classify every
// incoming push. Anything outside this allowlist (typing, receipts, settings
// sync, group metadata, sender-key distribution, future kinds, ...) is silent.
const USER_FACING_INNER_KINDS: ReadonlySet<number> = new Set([
  CHAT_MESSAGE_KIND,
  REACTION_KIND,
])

export function isUserFacingInnerKind(kind: number): boolean {
  return USER_FACING_INNER_KINDS.has(kind)
}


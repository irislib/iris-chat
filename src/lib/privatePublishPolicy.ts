import type { VerifiedEvent } from 'nostr-tools'
type PublicationFacts = Pick<VerifiedEvent, 'kind' | 'tags'>
const labelTag = (tag: string[]) => tag[0] === 'encrypted_device_labels' ||
  (tag[0] === 'f' && tag[1] === 'encrypted_device_labels')
export function hasLegacyPrivateRoster(event: PublicationFacts): boolean {
  return event.kind === 37368 && event.tags.some(labelTag)
}
/** Signing a public roster is allowed; persisting ordinary private data with a static key is not. */
export function assertPrivatePublicationPolicy(event: PublicationFacts): void {
  if (hasLegacyPrivateRoster(event)) throw new Error('Device list update needs confirmation; old private names remain local')
  if ([10445, 10446, 10447, 10449, 10450, 10451, 10452, 10453, 10454, 10455, 10456, 10461, 10462, 21112, 21113].includes(event.kind) ||
    ([7368,37368].includes(event.kind) && event.tags.some(tag => tag[0] === 'type' && ['private_contact', 'private_setting', 'group_roster'].includes(tag[1]))) ||
    (event.kind === 30078 && event.tags.some(tag => tag[0] === 't' && tag[1] === 'nostr-social-memory/v1'))) {
    throw new Error('Private settings must use the encrypted device queue')
  }
}
/** Retire only an ACKed replacement of the exact intended public authorization. */
export function coversLegacyPrivateRoster(replacement: VerifiedEvent, blocked: VerifiedEvent): boolean {
  if (replacement.kind !== 37368 || hasLegacyPrivateRoster(replacement) || !hasLegacyPrivateRoster(blocked) ||
    replacement.pubkey !== blocked.pubkey || replacement.created_at < blocked.created_at ||
    replacement.content !== blocked.content) return false
  const tags = (event: VerifiedEvent) => event.tags.filter(tag => !labelTag(tag)).map(tag => JSON.stringify(tag)).sort()
  return JSON.stringify(tags(replacement)) === JSON.stringify(tags(blocked))
}

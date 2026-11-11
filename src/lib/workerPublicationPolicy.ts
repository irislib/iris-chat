import { validateEvent, verifyEvent, type VerifiedEvent } from 'nostr-tools'
import type { NostrEvent, RuntimePublishOptions } from 'nostr-pubsub'
import { hasMetadataPrivacyVersion } from 'nostr-double-ratchet'
import { assertPrivatePublicationPolicy } from './privatePublishPolicy'

/**
 * What produced a message envelope. A pairwise ratchet carrier and shared group
 * ciphertext have the same wire shape, so only the queue that accepted the
 * envelope from a private session can vouch for it. Nothing else may be sent.
 */
export type PublicationCarrier = 'pairwise'
export type WorkerPublishOptions = RuntimePublishOptions & { carrier?: PublicationCarrier }

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
function signedEnvelope(value: unknown): VerifiedEvent | null {
  if (!record(value) || !validateEvent(value) || typeof value.id !== 'string' || typeof value.sig !== 'string') return null
  const event = { ...value, id: value.id, sig: value.sig }
  return verifyEvent(event) ? event : null
}

/** Exactly the version and header tags the protocol writes; a recipient is never named. */
export function namesNoRecipient(event: Pick<NostrEvent, 'kind' | 'tags'>): boolean {
  return event.kind === 1060 && Array.isArray(event.tags) && event.tags.length === 2 &&
    event.tags.every(tag => Array.isArray(tag) && tag.length === 2 && tag.every(part => typeof part === 'string')) &&
    event.tags.some(tag => tag[0] === 'v' && tag[1] === '2') &&
    event.tags.some(tag => tag[0] === 'header' && !!tag[1])
}

/** Old call alerts disclose caller identities, including v2 wrappers around ratchet ciphertext. */
export function assertWorkerPublicationPolicy(event: NostrEvent, carrier?: PublicationCarrier): void {
  assertPrivatePublicationPolicy(event)
  const publicInvite = event.kind === 30078 && event.tags.some(tag =>
    tag[0] === 'd' && tag[1]?.startsWith('double-ratchet/invites/'))
  if (([1059, 1060].includes(event.kind) || publicInvite) && !hasMetadataPrivacyVersion(event)) {
    throw new Error('Old encrypted messages cannot be resent')
  }
  if (event.kind === 1060) {
    // Device keys are public: a recipient tag lets anyone link deliveries to devices.
    if (event.tags.some(tag => tag[0] === 'p')) throw new Error('Message envelopes must not name a recipient')
    if (!namesNoRecipient(event)) throw new Error('Message envelopes carry only the version and header')
    if (carrier !== 'pairwise') throw new Error('Group messages must use private sessions')
  }
  if (event.kind !== 21111) return
  let value: unknown
  try { value = JSON.parse(event.content) } catch { throw new Error('Old call alerts cannot be resent') }
  if (!record(value) || value.type !== 'call-wake' || value.v !== 3 || !Array.isArray(value.events) ||
    value.events.length < 1 || value.events.length > 2 ||
    (value.bootstrapEventId !== undefined && (typeof value.bootstrapEventId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.bootstrapEventId) || value.events.length !== 1))) {
    throw new Error('Invalid encrypted call alert')
  }
  const envelopes = value.events.map(signedEnvelope)
  const message = envelopes.at(-1)
  const target = event.tags.filter(tag => tag[0] === 'p')
  // The wake names the device to ring; the message inside it names nobody.
  if (!message || !namesNoRecipient(message) || envelopes.some(envelope => !envelope || !hasMetadataPrivacyVersion(envelope)) ||
    (envelopes.length === 2 && envelopes[0]?.kind !== 1059) ||
    target.length !== 1 || !/^[a-f0-9]{64}$/.test(target[0]?.[1] ?? '') || carrier !== 'pairwise') {
    throw new Error('Invalid encrypted call alert')
  }
}

export function canRetryWorkerPublication(event: NostrEvent, carrier?: PublicationCarrier): boolean {
  try { assertWorkerPublicationPolicy(event, carrier); return true } catch { return false }
}

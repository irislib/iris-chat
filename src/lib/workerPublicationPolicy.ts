import { validateEvent, verifyEvent, type VerifiedEvent } from 'nostr-tools'
import type { NostrEvent } from 'nostr-pubsub'
import { assertPrivatePublicationPolicy } from './privatePublishPolicy'

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
function signedEnvelope(value: unknown): VerifiedEvent | null {
  if (!record(value) || !validateEvent(value) || typeof value.id !== 'string' || typeof value.sig !== 'string') return null
  const event = { ...value, id: value.id, sig: value.sig }
  return verifyEvent(event) ? event : null
}

/** Legacy call alerts contain static device-key ciphertext, unlike v2 ratchet envelopes. */
export function assertWorkerPublicationPolicy(event: NostrEvent): void {
  assertPrivatePublicationPolicy(event)
  if (event.kind !== 21111) return
  let value: unknown
  try { value = JSON.parse(event.content) } catch { throw new Error('Old call alerts cannot be resent') }
  if (!record(value) || value.type !== 'call-wake' || value.v !== 2 || !Array.isArray(value.events) ||
    value.events.length < 1 || value.events.length > 2 ||
    (value.bootstrapEventId !== undefined && (typeof value.bootstrapEventId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.bootstrapEventId) || value.events.length !== 1))) {
    throw new Error('Invalid encrypted call alert')
  }
  const envelopes = value.events.map(signedEnvelope)
  const message = envelopes.at(-1)
  const target = event.tags.filter(tag => tag[0] === 'p')
  if (!message || message.kind !== 1060 || (envelopes.length === 2 && envelopes[0]?.kind !== 1059) ||
    target.length !== 1 || message.tags.filter(tag => tag[0] === 'p').length !== 1 ||
    !message.tags.some(tag => tag[0] === 'p' && tag[1] === target[0]?.[1])) {
    throw new Error('Invalid encrypted call alert')
  }
}

export function canRetryWorkerPublication(event: NostrEvent): boolean {
  try { assertWorkerPublicationPolicy(event); return true } catch { return false }
}

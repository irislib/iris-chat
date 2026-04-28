import { verifyEvent, type VerifiedEvent } from 'nostr-tools'

export const PUSH_NOSTR_EVENT_MESSAGE = 'PUSH_NOSTR_EVENT'

const PUSH_EVENT_KEYS = [
  'event',
  'outer_event',
  'outer_event_json',
  'nostr_event',
  'nostr_event_json',
] as const

function parseCandidate(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  return value
}

export function asVerifiedPushNostrEvent(value: unknown): VerifiedEvent | null {
  const candidate = parseCandidate(value)
  if (!candidate || typeof candidate !== 'object') return null

  try {
    return verifyEvent(candidate as VerifiedEvent)
      ? (candidate as VerifiedEvent)
      : null
  } catch {
    return null
  }
}

export function extractPushNostrEvent(payload: unknown): VerifiedEvent | null {
  if (!payload || typeof payload !== 'object') return null

  for (const key of PUSH_EVENT_KEYS) {
    const event = asVerifiedPushNostrEvent((payload as Record<string, unknown>)[key])
    if (event) return event
  }

  return null
}

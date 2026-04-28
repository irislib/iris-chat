// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools'
import { extractPushNostrEvent } from './pushEvents'

function signedEvent() {
  const unsigned: Parameters<typeof finalizeEvent>[0] = {
    kind: 1060,
    created_at: 1,
    tags: [['header', 'x']],
    content: 'ciphertext',
  }
  return finalizeEvent(unsigned, generateSecretKey())
}

describe('push event payload helpers', () => {
  it('extracts a verified event object from a notification payload', () => {
    const event = signedEvent()
    expect(extractPushNostrEvent({ event })?.id).toBe(event.id)
  })

  it('extracts a verified event JSON string from alternate payload keys', () => {
    const event = signedEvent()
    expect(extractPushNostrEvent({ outer_event_json: JSON.stringify(event) })?.id).toBe(event.id)
  })

  it('rejects unverified events', () => {
    const event = signedEvent()
    const tampered = JSON.parse(JSON.stringify(event))
    tampered.sig = '0'.repeat(128)
    expect(extractPushNostrEvent({ event: tampered })).toBeNull()
  })
})

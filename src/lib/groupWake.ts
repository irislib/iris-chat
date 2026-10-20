import { getEventHash, verifyEvent, type Event, type VerifiedEvent } from 'nostr-tools'
import { hasMetadataPrivacyVersion, type Rumor } from 'nostr-double-ratchet'

export const GROUP_WAKE_KIND = 21113

/** The shared group event is visible only inside each recipient's ratchet. */
export function groupWakeRumor(event: Event): Pick<Rumor, 'kind' | 'content' | 'tags'> {
  const rumor = { kind: GROUP_WAKE_KIND, content: JSON.stringify({ v: 1, type: 'group-wake', event }), tags: [] }
  if (!parseGroupWake(rumor)) throw new Error('Invalid group wake event')
  return rumor
}

export function parseGroupWake(rumor: Pick<Rumor, 'kind' | 'content'>): VerifiedEvent | undefined {
  if (rumor.kind !== GROUP_WAKE_KIND) return
  try {
    const value = JSON.parse(rumor.content)
    const event = value?.event as Event | undefined
    if (value?.v !== 1 || value.type !== 'group-wake' || !event ||
      event.kind !== 1060 || !hasMetadataPrivacyVersion(event) || !verifyEvent(event)) return
    return event as VerifiedEvent
  } catch { return }
}

/** Web groups carry the canonical message inside the library's kind-14 rumor. */
export function parseSerializedGroupRuntimeRumor(content: string): Rumor | null {
  let value: Record<string, unknown>
  try { value = JSON.parse(content) } catch { return null }
  if (!value || typeof value !== 'object' || typeof value.pubkey !== 'string' ||
    typeof value.kind !== 'number' || typeof value.content !== 'string' ||
    typeof value.created_at !== 'number' || !Array.isArray(value.tags) ||
    !value.tags.every(tag => Array.isArray(tag) && tag.every(part => typeof part === 'string'))) return null
  const tags = value.tags as string[][]
  if (!tags.some(tag => tag[0] === 'l' && typeof tag[1] === 'string')) return null
  const rumor: Rumor = {
    id: '', pubkey: value.pubkey, kind: value.kind, content: value.content,
    created_at: value.created_at, tags,
  }
  const id = getEventHash(rumor)
  if (typeof value.id === 'string' && value.id && value.id !== id) return null
  rumor.id = id
  return rumor
}

import { getEventHash } from 'nostr-tools'
import type { Rumor } from 'nostr-double-ratchet'
export { PRIVATE_GROUP_DELIVERY_KIND as GROUP_WAKE_KIND, parsePrivateGroupDelivery as parseGroupWake } from 'nostr-double-ratchet'

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

import type { Rumor } from 'nostr-double-ratchet'
import { validMessageRead } from './privateStateProtocol'
import { applyMessageRead } from './privateStateStore'
/** Only call after authenticating the transport as a currently linked own device. */
export async function applyAuthenticatedOwnRead(owner: string, chatId: string, rumor: Rumor, authorized: () => boolean): Promise<void> {
  if (rumor.kind !== 15 || rumor.content !== 'seen' || !(/^[0-9a-f]{64}$/.test(chatId) || /^group:[^\x00-\x20]{1,128}$/.test(chatId))) return
  const encoded = rumor.tags.find(tag => tag[0] === 'iris-read-state')?.[1]
  if (!encoded || encoded.length > 32768) return
  let state: { seenMessages?: Record<string,unknown> }
  try { state = JSON.parse(encoded) } catch { return }
  if (!state?.seenMessages || typeof state.seenMessages !== 'object' || Array.isArray(state.seenMessages) || Object.keys(state.seenMessages).length > 128) return
  for (const [id,read] of Object.entries(state.seenMessages)) if (id && id.length <= 128 && validMessageRead(read)) await applyMessageRead(owner,chatId,id,read,authorized)
}

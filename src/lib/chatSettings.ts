import { normalizeDisappearingTtl } from './disappearingNotice'

export interface ChatSettingsPayloadV1 {
  type: 'chat-settings'
  v: 1
  messageTtlSeconds: number | null
}

export function parseChatSettingsContent(content: string): ChatSettingsPayloadV1 | null {
  if (!content) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (obj.type !== 'chat-settings') return null
  if (obj.v !== 1) return null

  const ttl = obj.messageTtlSeconds
  if (ttl === null) {
    return { type: 'chat-settings', v: 1, messageTtlSeconds: null }
  }
  if (typeof ttl === 'number' && Number.isFinite(ttl)) {
    return {
      type: 'chat-settings',
      v: 1,
      messageTtlSeconds: normalizeDisappearingTtl(ttl),
    }
  }

  return null
}

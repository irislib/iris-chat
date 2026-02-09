import {
  buildGroupMetadataContent,
  GROUP_METADATA_KIND,
} from 'nostr-double-ratchet'
import { get } from 'svelte/store'
import { getSessionManager } from './privateChats'
import { getPubkey } from './identity'
import { expirationStore } from './expirationStore'
import { groups } from './groups'
import { fanOutGroupMetadata } from './groups'

const normalizeTtlSeconds = (ttlSeconds: number | null): number | null => {
  if (ttlSeconds === null) return null
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds)) return null
  const floored = Math.floor(ttlSeconds)
  return floored > 0 ? floored : null
}

export async function setDmDisappearingMessages(
  peerPubkey: string,
  messageTtlSeconds: number | null
): Promise<void> {
  if (!peerPubkey) return

  const normalizedTtl = normalizeTtlSeconds(messageTtlSeconds)

  expirationStore.setExpiration(peerPubkey, normalizedTtl)

  const sessionManager = getSessionManager()
  const myPubKey = getPubkey()
  if (!myPubKey) return
  if (!sessionManager) return

  await sessionManager.setChatSettingsForPeer(peerPubkey, normalizedTtl)
}

export async function setGroupDisappearingMessages(
  groupId: string,
  messageTtlSeconds: number | null
): Promise<void> {
  if (!groupId) return

  const myPubKey = getPubkey()
  if (!myPubKey) return

  const currentGroups = get(groups)
  const group = currentGroups.get(groupId)
  if (!group) return

  const normalizedTtl = normalizeTtlSeconds(messageTtlSeconds)

  expirationStore.setExpiration(groupId, normalizedTtl)

  const sessionManager = getSessionManager()
  if (sessionManager) {
    await sessionManager
      .setExpirationForGroup(
        groupId,
        normalizedTtl ? { ttlSeconds: normalizedTtl } : null
      )
      .catch(() => {})
  }

  // Publish group metadata update so all members converge on the same setting
  const base = JSON.parse(buildGroupMetadataContent(group)) as Record<string, unknown>
  base.messageTtlSeconds = normalizedTtl

  fanOutGroupMetadata(groupId, JSON.stringify(base))
}

export async function syncDisappearingMessagesToSessionManager(): Promise<void> {
  const sessionManager = getSessionManager()
  if (!sessionManager) return

  const expirations = expirationStore.getAllExpirations()
  const entries = Object.entries(expirations).filter(([, ttl]) => ttl !== undefined)

  await Promise.all(
    entries.map(async ([chatId, ttl]) => {
      const isPubkey = /^[0-9a-f]{64}$/i.test(chatId)
      const options = ttl ? { ttlSeconds: ttl } : null
      if (isPubkey) {
        await sessionManager.setExpirationForPeer(chatId, options).catch(() => {})
      } else {
        await sessionManager.setExpirationForGroup(chatId, options).catch(() => {})
      }
    })
  )
}

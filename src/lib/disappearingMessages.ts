import {
  buildGroupMetadataContent,
} from 'nostr-double-ratchet'
import { get } from 'svelte/store'
import { getNdrRuntime } from './privateChats'
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

  const myPubKey = getPubkey()
  if (!myPubKey) return

  await getNdrRuntime().setChatSettingsForPeer(peerPubkey, normalizedTtl)
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
  if (!group.admins?.includes(myPubKey)) return

  const normalizedTtl = normalizeTtlSeconds(messageTtlSeconds)

  expirationStore.setExpiration(groupId, normalizedTtl)

  await getNdrRuntime()
    .setExpirationForGroup(
      groupId,
      normalizedTtl ? { ttlSeconds: normalizedTtl } : null
    )
    .catch(() => {})

  // Publish group metadata update so all members converge on the same setting
  const base = JSON.parse(buildGroupMetadataContent(group)) as Record<string, unknown>
  base.messageTtlSeconds = normalizedTtl

  fanOutGroupMetadata(groupId, JSON.stringify(base))
}

export async function syncDisappearingMessagesToNdrRuntime(): Promise<void> {
  const expirations = expirationStore.getAllExpirations()
  const entries = Object.entries(expirations).filter(([, ttl]) => ttl !== undefined)

  await Promise.all(
    entries.map(async ([chatId, ttl]) => {
      const isPubkey = /^[0-9a-f]{64}$/i.test(chatId)
      const options = ttl ? { ttlSeconds: ttl } : null
      if (isPubkey) {
        await getNdrRuntime().setExpirationForPeer(chatId, options).catch(() => {})
      } else {
        await getNdrRuntime().setExpirationForGroup(chatId, options).catch(() => {})
      }
    })
  )
}

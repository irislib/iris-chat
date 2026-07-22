import { get } from 'svelte/store'
import { getNdrRuntime } from './privateChats'
import { getPubkey } from './identity'
import { expirationStore } from './expirationStore'
import { groups, sendGroupSettingsEvent } from './groups'
import { normalizeDisappearingTtl } from './disappearingNotice'

export async function setDmDisappearingMessages(
  peerPubkey: string,
  messageTtlSeconds: number | null
): Promise<void> {
  if (!peerPubkey) return

  const normalizedTtl = normalizeDisappearingTtl(messageTtlSeconds)

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

  const normalizedTtl = normalizeDisappearingTtl(messageTtlSeconds)

  expirationStore.setExpiration(groupId, normalizedTtl)

  await getNdrRuntime()
    .setExpirationForGroup(
      groupId,
      normalizedTtl ? { ttlSeconds: normalizedTtl } : null
    )
    .catch(() => {})

  sendGroupSettingsEvent(groupId, normalizedTtl)
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

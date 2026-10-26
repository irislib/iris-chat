import { Group, InMemoryStorageAdapter, getExpirationTimestampSeconds } from 'nostr-double-ratchet'
import { verifyEvent, type Event } from 'nostr-tools'
import { db } from './storage'
import { parseSerializedGroupRuntimeRumor } from './groupWake'

/** A wake may only carry its authenticated session sender's group channel. */
export async function groupWakeSenderMatches(owner: string, event: Event, sender: string): Promise<boolean | undefined> {
  for (const group of await db.groups.toArray()) {
    const prefix = `v1/broadcast-channel/group/${group.id}/sender/`
    const rows = await db.sessionManager.where('key').between(prefix, prefix + '\uffff').toArray()
    for (const row of rows) {
      if (!row.key.endsWith('/sender-event-pubkey') || row.value !== event.pubkey) continue
      const senderPrefix = row.key.slice(0, -'sender-event-pubkey'.length)
      const senderOwner = rows.find(item => item.key === senderPrefix + 'sender-owner-pubkey')?.value
      return group.accepted !== false && group.members.includes(owner) &&
        group.members.includes(sender) && senderOwner === sender
    }
  }
  // The encrypted sender-key distribution can arrive after the wake.
  return undefined
}

/** Use the library's authenticated group channel over a disposable snapshot.
 * Worker decryption must never advance the foreground runtime's ratchets. */
export async function groupPushChannels(owner: string) {
  const groups = (await db.groups.toArray()).filter(group => group.accepted !== false && group.members.includes(owner))
  return Promise.all(groups.map(async data => {
    const storage = new InMemoryStorageAdapter()
    const prefix = `v1/broadcast-channel/group/${data.id}/sender/`
    const rows = await db.sessionManager.where('key').between(prefix,prefix + '\uffff').toArray()
    for (const row of rows) await storage.put(row.key,structuredClone(row.value))
    const channel = new Group({data,ourOwnerPubkey:owner,ourDevicePubkey:owner,storage})
    const authors = await channel.listSenderEventPubkeys()
    // These keys are only for local decryption, never notification-server filters.
    return { chatId:`group:${data.id}`, channel, authors }
  }))
}
export async function decryptGroupPush(owner: string, event: Event, sender: string) {
  if (!sender || !verifyEvent(event)) return
  if (await groupWakeSenderMatches(owner, event, sender) !== true) return
  for (const {chatId,channel,authors} of await groupPushChannels(owner)) {
    if (!authors.includes(event.pubkey)) continue
    // The foreground runtime may already have consumed the group ratchet key.
    // Reuse its preview only after the private wake authenticated this channel.
    const processed = await db.processedEvents.get(event.id)
    if (processed?.chatId === chatId && processed.author === sender) {
      return { success:true as const,chatId,kind:processed.kind,content:processed.content,
        isSelfMessage:sender === owner,messageId:processed.messageId,
        author:sender,createdAtSecs:processed.createdAtSecs }
    }
    const result = await channel.handleOuterEvent(event)
    if (!result) return { success:false as const,chatId }
    const inner = parseSerializedGroupRuntimeRumor(result.inner.content) ?? result.inner
    if (inner !== result.inner && (inner.pubkey !== result.senderOwnerPubkey && inner.pubkey !== result.senderDevicePubkey ||
      inner.tags.find(tag => tag[0] === 'l')?.[1] !== chatId.slice(6))) return {success:false as const,chatId}
    return { success:true as const,chatId,kind:inner.kind,content:inner.content,
      isSelfMessage:result.senderOwnerPubkey === owner,messageId:inner.id,
      expiresAt:getExpirationTimestampSeconds(inner),author:result.senderOwnerPubkey,createdAtSecs:inner.created_at,
      decrypted:result }
  }
}

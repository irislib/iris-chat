import { Group, InMemoryStorageAdapter, getExpirationTimestampSeconds } from 'nostr-double-ratchet'
import { verifyEvent, type Event } from 'nostr-tools'
import { db } from './storage'

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
    const foreignSenderPrefixes = rows.filter(row => row.key.endsWith('/sender-owner-pubkey') && typeof row.value === 'string' && row.value !== owner && data.members.includes(row.value)).map(row => row.key.slice(0,-'sender-owner-pubkey'.length))
    const foreignAuthors = new Set(rows.filter(row => foreignSenderPrefixes.some(prefix => row.key === prefix + 'sender-event-pubkey')).map(row => row.value))
    const authors = await channel.listSenderEventPubkeys()
    return { subscriptionAuthors:authors.filter(author => foreignAuthors.has(author)), chatId:`group:${data.id}`, channel, authors }
  }))
}
export async function decryptGroupPush(owner: string, event: Event) {
  if (!verifyEvent(event)) return
  for (const {chatId,channel,authors} of await groupPushChannels(owner)) {
    if (!authors.includes(event.pubkey)) continue
    const result = await channel.handleOuterEvent(event)
    if (!result) return { success:false as const,chatId }
    return { success:true as const,chatId,kind:result.inner.kind,content:result.inner.content,
      isSelfMessage:result.senderOwnerPubkey === owner,messageId:result.inner.id,
      expiresAt:getExpirationTimestampSeconds(result.inner),author:result.senderOwnerPubkey,createdAtSecs:result.inner.created_at }
  }
}

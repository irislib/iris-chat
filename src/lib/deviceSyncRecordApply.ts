import { get } from 'svelte/store'
import { getEventHash, type Event } from 'nostr-tools'
import type { Rumor } from 'nostr-double-ratchet'
import { db, admitHistoryMessage, type StoredMessage } from './storage'
import { saveReactionHead, saveGroupSettingsHead, saveSignedProfileHead, messageWithReactionHeads, projectReactionHeads, groupSettingsHeads, hasReactionHead } from './deviceSyncRecordStore'
import type { DeviceSyncReaction, DeviceSyncGroupSettings } from './deviceSyncRecords'

export function controlClock(rumor: Pick<Rumor, 'id' | 'pubkey' | 'created_at' | 'kind' | 'tags' | 'content'>) {
  const ms = Number(rumor.tags.find(tag => tag[0] === 'ms')?.[1])
  return { id: rumor.id || getEventHash(rumor), createdAt: rumor.created_at,
    ...(Number.isSafeInteger(ms) && ms >= 0 && Math.floor(ms / 1000) === rumor.created_at && { createdAtMs: ms }) }
}

export async function refreshReactionView(message: StoredMessage): Promise<void> {
  if (message.sessionId.startsWith('group:')) {
    const { groupMessages } = await import('./groups')
    groupMessages.update(all => {
      const id = message.sessionId.slice(6), rows = all.get(id)
      if (!rows?.some(row => row.id === message.id)) return all
      return new Map(all).set(id, rows.map(row => row.id === message.id ? { ...row, reactions: message.reactions } : row))
    })
  } else {
    const { chats, currentChat } = await import('./chat')
    chats.update(all => {
      const chat = all.get(message.sessionId)
      if (!chat?.messages.some(row => row.id === message.id)) return all
      const updated = { ...chat, messages: chat.messages.map(row => row.id === message.id ? { ...row, reactions: message.reactions } : row) }
      if (get(currentChat)?.id === chat.id) currentChat.set(updated)
      return new Map(all).set(chat.id, updated)
    })
  }
}

export async function applyReactionRecord(owner: string, reaction: DeviceSyncReaction, authorized = () => true): Promise<boolean> {
  if (!authorized() || reaction.createdAt > Date.now() / 1000 + 300) return false
  if (reaction.chatId.startsWith('group:')) {
    const { groups } = await import('./groups')
    const group = get(groups).get(reaction.chatId.slice(6))
    if (!group || !group.members.includes(owner) || !group.members.includes(reaction.author)) return false
  } else {
    const { chats } = await import('./chat')
    if (!get(chats).has(reaction.chatId) || reaction.author !== owner && reaction.author !== reaction.chatId) return false
  }
  const changed = await saveReactionHead(owner, reaction, authorized)
  const message = changed && authorized() ? await db.messages.get(reaction.messageId) : undefined
  if (message && authorized()) await refreshReactionView(message)
  return changed
}

export async function captureReaction(owner: string, chatId: string, rumor: Rumor, author: string, messageId: string, emoji: string): Promise<void> {
  if (rumor.id && getEventHash(rumor) !== rumor.id) return
  const targets = new Set(rumor.tags.filter(tag => tag[0] === 'e').map(tag => tag[1]))
  if (targets.size > 1) {
    // Legacy multi-target events do not have an unambiguous typed record ID.
    const target = await db.messages.get(messageId)
    if (target?.sessionId !== chatId) return
    const projected = projectReactionHeads(target, [{ ...controlClock(rumor), chatId, author, messageId, emoji }])
    await persistMessageWithReactions(owner, projected)
    await refreshReactionView(await db.messages.get(messageId) ?? projected)
    return
  }
  await applyReactionRecord(owner, { ...controlClock(rumor), chatId, author, messageId, emoji })
}

export async function applyGroupSettingsRecord(owner: string, settings: DeviceSyncGroupSettings, authorized = () => true): Promise<boolean> {
  const { groups } = await import('./groups')
  const group = get(groups).get(settings.groupId)
  if (!authorized() || !group || !group.members.includes(owner) || !group.admins.includes(settings.author) || settings.createdAt > Date.now() / 1000 + 300) return false
  const changed = await saveGroupSettingsHead(owner, settings, authorized)
  if (changed && authorized() && (await groupSettingsHeads(owner)).find(head => head.groupId === settings.groupId)?.id === settings.id) {
    const { expirationStore } = await import('./expirationStore')
    expirationStore.setExpiration(settings.groupId, settings.messageTtlSeconds)
  }
  return changed
}

export async function applyProfileRecord(owner: string, event: Event, contacts: Set<string>, authorized = () => true): Promise<boolean> {
  const changed = await saveSignedProfileHead(owner, event, contacts, authorized)
  if (changed && authorized()) {
    const { addProfileToCache } = await import('./profile')
    const content = JSON.parse(event.content)
    const profile: import('./profile').Profile = { pubkey: event.pubkey, eventCreatedAt: event.created_at, eventId: event.id }
    for (const field of ['name', 'display_name', 'username', 'picture', 'nip05', 'about'] as const) {
      if (typeof content[field] === 'string') profile[field] = content[field]
    }
    addProfileToCache(profile)
  }
  return changed
}

export async function persistMessageWithReactions(owner: string, message: StoredMessage): Promise<void> {
  const updated = await db.transaction('rw', db.messages, db.sessionManager, async () => {
    const projected = await messageWithReactionHeads(owner, message)
    await db.messages.put(projected)
    return projected
  })
  // Rebuild only when durable controls actually changed the rendered value.
  if (JSON.stringify(updated.reactions ?? {}) !== JSON.stringify(message.reactions ?? {})) await refreshReactionView(updated)
}

/** Recover a committed control if shutdown preceded its local preference write. */
export async function restoreGroupSettings(owner: string, groupId: string): Promise<void> {
  const { groups } = await import('./groups')
  const group = get(groups).get(groupId)
  if (!group?.members.includes(owner)) return
  const head = (await groupSettingsHeads(owner)).find(record => record.groupId === groupId)
  if (!head || !group.admins.includes(head.author)) return
  const { expirationStore } = await import('./expirationStore')
  expirationStore.setExpiration(groupId, head.messageTtlSeconds)
}

export async function admitRecordMessage(owner: string, message: StoredMessage,
  legacyReactions: Array<{ author: string; emoji: string }> | undefined, allowLegacy: boolean,
  allowedAuthors: Set<string>, authorized: () => boolean): Promise<StoredMessage | undefined> {
  return db.transaction('rw', db.messages, db.sessionManager, async () => {
    const incoming = { ...message }
    if (allowLegacy && legacyReactions) {
      const reactions: Record<string, string[]> = {}
      for (const reaction of legacyReactions) {
        if (!allowedAuthors.has(reaction.author) || await hasReactionHead(owner, message.sessionId, message.id, reaction.author)) continue
        for (const emoji of Object.keys(reactions)) reactions[emoji] = reactions[emoji].filter(author => author !== reaction.author)
        ;(reactions[reaction.emoji] ??= []).push(reaction.author)
      }
      incoming.reactions = Object.fromEntries(Object.entries(reactions).filter(([, authors]) => authors.length))
    }
    const projected = await messageWithReactionHeads(owner, incoming)
    return await admitHistoryMessage(projected, authorized) ? projected : undefined
  })
}

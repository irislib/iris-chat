import { acceptChatFromActivity, acceptChatsFromActivity } from './messageRequests'
import { acceptFromStoredActivity, restoreStoredRequestAcceptance } from './requestActivity'
import { validMessageRead } from './privateStateProtocol'
import { projectMessageRead } from './privateStateStore'
import { messageWithMutations, refreshMessageMutationView } from './messageMutations'
import { get } from 'svelte/store'
import { getEventHash, type Event } from 'nostr-tools'
import type { Rumor } from 'nostr-double-ratchet'
import { db, type StoredMessage } from './storage'
import { saveReactionHead, saveGroupSettingsHead, saveSignedProfileHead, messageWithReactionHeads, projectReactionHeads, groupSettingsHead, hasReactionHead } from './deviceSyncRecordStore'
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
  if (changed && authorized() && reaction.author === owner) acceptChatFromActivity(owner, reaction.chatId, reaction.createdAtMs ?? reaction.createdAt * 1000)
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
    if (author === owner) {
      const clock = controlClock(rumor)
      acceptChatFromActivity(owner, chatId, clock.createdAtMs ?? clock.createdAt * 1000)
    }
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
  if (changed && authorized() && (await groupSettingsHead(owner, settings.groupId))?.id === settings.id) {
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

export async function persistMessageWithReactions(owner: string, message: StoredMessage): Promise<StoredMessage> {
  const updated = await db.transaction('rw', db.messages, db.sessionManager, async () => {
    const projected = await projectMessageRead(owner, await messageWithMutations(owner, await messageWithReactionHeads(owner, message)))
    await db.messages.put(projected)
    return projected
  })
  acceptFromStoredActivity(owner, updated)
  // Rebuild only when durable controls actually changed the rendered value.
  if (updated.editedAt !== message.editedAt || updated.deletedAt !== message.deletedAt || updated.content !== message.content) await refreshMessageMutationView(updated)
  if (JSON.stringify(updated.reactions ?? {}) !== JSON.stringify(message.reactions ?? {})) await refreshReactionView(updated)
  return updated
}

/** Recover a committed control if shutdown preceded its local preference write. */
export async function restoreGroupSettings(owner: string, groupId: string): Promise<void> {
  const { groups } = await import('./groups')
  const group = get(groups).get(groupId)
  if (!group?.members.includes(owner)) return
  const head = await groupSettingsHead(owner, groupId)
  if (!head || !group.admins.includes(head.author)) return
  const { expirationStore } = await import('./expirationStore')
  expirationStore.setExpiration(groupId, head.messageTtlSeconds)
}

export interface AdmitRecordMessageInput {
  message: StoredMessage
  legacyReactions?: Array<{ author: string; emoji: string }>
  allowedAuthors: Set<string>
}

export async function admitRecordMessages(
  owner: string,
  entries: AdmitRecordMessageInput[],
  allowLegacy: boolean,
  authorized: () => boolean,
): Promise<Array<StoredMessage | undefined>> {
  if (entries.length === 0) return []

  const results: Array<StoredMessage | undefined> = new Array(entries.length).fill(undefined)
  const admittedEntries: Array<{ stored: StoredMessage; hadOwnLegacyReaction: boolean }> = []

  await db.transaction('rw', db.messages, db.sessionManager, async () => {
    if (!authorized()) return
    const uniqueChatIds = [...new Set(entries.map(e => e.message.sessionId))]
    const [existingMessages, deletedMessageRows, deletedChatRows, mutationTargetRows, readRows] = await Promise.all([
      db.messages.bulkGet(entries.map(e => e.message.id)),
      db.sessionManager.bulkGet(entries.map(e => `history-deleted-message:${e.message.id}`)),
      db.sessionManager.bulkGet(uniqueChatIds.map(chatId => `history-deleted-chat:${chatId}`)),
      db.sessionManager.bulkGet(entries.map(e => `message-mutation-target:${owner}:${JSON.stringify([e.message.sessionId, e.message.id])}`)),
      db.sessionManager.bulkGet(entries.map(e => (!e.message.isMine && !e.message.call && e.message.status !== 'seen')
        ? `private-state-v1:${owner}:read:${JSON.stringify([e.message.sessionId, e.message.id])}`
        : '')),
    ])

    const deletedChatCutoff = new Map<string, number>()
    for (let i = 0; i < uniqueChatIds.length; i++) {
      const value = deletedChatRows[i]?.value
      if (typeof value === 'number') deletedChatCutoff.set(uniqueChatIds[i], value)
    }

    const seenBatchIds = new Set<string>()
    const candidates: Array<{
      index: number
      entry: AdmitRecordMessageInput
      hasMutationTarget: boolean
      pendingRead: unknown
    }> = []
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const msg = entry.message
      if (existingMessages[i] || deletedMessageRows[i] || seenBatchIds.has(msg.id)) continue
      const cutoff = deletedChatCutoff.get(msg.sessionId)
      if (cutoff !== undefined && Math.floor(msg.timestamp / 1000) <= cutoff) continue
      seenBatchIds.add(msg.id)
      candidates.push({
        index: i,
        entry,
        hasMutationTarget: Boolean((mutationTargetRows[i]?.value as string[] | undefined)?.length),
        pendingRead: readRows[i]?.value,
      })
    }
    if (!candidates.length || !authorized()) return

    const reactionProjected = await Promise.all(
      candidates.map(async ({ entry }) => {
        const incoming = { ...entry.message }
        if (allowLegacy && entry.legacyReactions) {
          const reactions: Record<string, string[]> = {}
          for (const reaction of entry.legacyReactions) {
            if (!entry.allowedAuthors.has(reaction.author) || await hasReactionHead(owner, incoming.sessionId, incoming.id, reaction.author)) continue
            for (const emoji of Object.keys(reactions)) reactions[emoji] = reactions[emoji].filter(author => author !== reaction.author)
            ;(reactions[reaction.emoji] ??= []).push(reaction.author)
          }
          incoming.reactions = Object.fromEntries(Object.entries(reactions).filter(([, authors]) => authors.length))
        }
        return messageWithReactionHeads(owner, incoming)
      }),
    )

    const toPut: StoredMessage[] = []
    const nowSecs = Date.now() / 1000
    for (let i = 0; i < candidates.length; i++) {
      const { index, entry, hasMutationTarget, pendingRead } = candidates[i]
      let projected = reactionProjected[i]
      if (hasMutationTarget) projected = await messageWithMutations(owner, projected)
      if (!projected.isMine && !projected.call && projected.status !== 'seen' && validMessageRead(pendingRead)) {
        if (
          (pendingRead.expiresAtSecs === undefined || pendingRead.expiresAtSecs > nowSecs) &&
          pendingRead.createdAtSecs === Math.floor(projected.timestamp / 1000)
        ) {
          projected = { ...projected, status: 'seen' }
        }
      }
      results[index] = projected
      toPut.push(projected)
      admittedEntries.push({
        stored: projected,
        hadOwnLegacyReaction: Boolean(allowLegacy && entry.legacyReactions?.some(r => r.author === owner)),
      })
    }

    if (!authorized()) {
      results.fill(undefined)
      admittedEntries.length = 0
      return
    }
    await db.messages.bulkPut(toPut)
  })

  if (admittedEntries.length > 0 && authorized()) {
    const ownActivity = new Map<string, number>()
    for (const { stored, hadOwnLegacyReaction } of admittedEntries) {
      if (stored.isMine) {
        const previous = ownActivity.get(stored.sessionId)
        if (previous === undefined || stored.timestamp > previous) ownActivity.set(stored.sessionId, stored.timestamp)
      }
      if (hadOwnLegacyReaction) await restoreStoredRequestAcceptance(owner, stored)
    }
    if (ownActivity.size > 0) acceptChatsFromActivity(owner, ownActivity)
  }

  return results
}

export async function admitRecordMessage(owner: string, message: StoredMessage,
  legacyReactions: Array<{ author: string; emoji: string }> | undefined, allowLegacy: boolean,
  allowedAuthors: Set<string>, authorized: () => boolean): Promise<StoredMessage | undefined> {
  return (await admitRecordMessages(owner, [{ message, legacyReactions, allowedAuthors }], allowLegacy, authorized))[0]
}

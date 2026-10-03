import { db, deletedHistoryRecords, isHistoryChatDeleted } from './storage'
import { reactionHeads, groupSettingsHeads, signedProfileHeads, saveSignedProfileHead } from './deviceSyncRecordStore'
import { applyReactionRecord, applyGroupSettingsRecord, applyProfileRecord } from './deviceSyncRecordApply'
import { deviceSyncRecordId, deviceSyncRecordTime, type DeviceSyncRecord, type DeviceSyncScope } from './deviceSyncRecords'
import { historyRecordId } from './deviceHistorySync'
import { deviceSyncPacketByteLength, DEVICE_SYNC_MAX_PACKET_BYTES, type DeviceSyncMessage, type DeviceSyncSnapshot } from './deviceSyncProtocol'
import type { Event } from 'nostr-tools'

/** The same bounded reconciliation engine reads current durable projections.
 * Private imports never call public profile/group authoring APIs. */
export function createDeviceSyncRecordAdapter(options: {
  owner: string
  snapshots(): DeviceSyncSnapshot[]
  messages(since: number, until: number): DeviceSyncMessage[]
  cachedProfiles?(contacts: string[]): Promise<Event[]>
  allowsLegacy(peer: string, since: number, until: number, linkId?: string): boolean
  applySnapshot(packet: DeviceSyncSnapshot, since: number | undefined, authorized: () => boolean, legacy?: boolean): Promise<number>
}) {
  async function state() {
    const packets = options.snapshots()
    const groups = packets.flatMap(packet => packet.groups)
    const contacts = new Set<string>()
    const chats = new Set<string>()
    for (const chat of packets.flatMap(packet => packet.chats)) if (!await isHistoryChatDeleted(chat.id)) { contacts.add(chat.id); chats.add(chat.id) }
    const currentGroups = []
    for (const group of groups) if (!await isHistoryChatDeleted(`group:${group.id}`)) {
      currentGroups.push(group)
      if (group.members.includes(options.owner)) group.members.forEach(member => contacts.add(member))
    }
    if (contacts.size > 100_000) throw new Error('Contact record limit exceeded')
    return { groups: currentGroups, contacts, chats }
  }
  async function records(scope: DeviceSyncScope, since: number, until: number): Promise<DeviceSyncRecord[]> {
    let all: DeviceSyncRecord[]
    if (scope === 'history') {
      all = options.messages(since, until).map(message => ({ type: 'message', message }))
      const current = await state()
      for (const reaction of await reactionHeads(options.owner)) {
        const group = reaction.chatId.startsWith('group:') ? current.groups.find(group => group.id === reaction.chatId.slice(6)) : undefined
        if (reaction.chatId.startsWith('group:') ? !group?.members.includes(options.owner) || !group.members.includes(reaction.author) :
          !current.chats.has(reaction.chatId) || reaction.author !== options.owner && reaction.author !== reaction.chatId) continue
        if (reaction.createdAt < since || reaction.createdAt > until || await isHistoryChatDeleted(reaction.chatId) ||
          await db.sessionManager.get(`history-deleted-message:${reaction.messageId}`)) continue
        const target = await db.messages.get(reaction.messageId)
        if (target?.expiresAt !== undefined && target.expiresAt <= Date.now() / 1000) continue
        all.push({ type: 'reaction', reaction })
      }
    } else {
      const current = await state()
      // Backfill original signed heads already present in the local event cache.
      // This never queries unrelated authors or fetches from message servers.
      const contacts = [...current.contacts]
      for (let index = 0; options.cachedProfiles && index < contacts.length; index += 64) {
        for (const event of await options.cachedProfiles(contacts.slice(index, index + 64))) {
          await saveSignedProfileHead(options.owner, event, current.contacts)
        }
      }
      const groups = new Map(current.groups.map(group => [group.id, group]))
      all = current.groups.map(group => ({ type: 'group', group }))
      for (const settings of await groupSettingsHeads(options.owner)) {
        if (groups.get(settings.groupId)?.members.includes(options.owner) && groups.get(settings.groupId)?.admins.includes(settings.author)) all.push({ type: 'groupSettings', settings })
      }
      for (const event of await signedProfileHeads(options.owner, current.contacts)) all.push({ type: 'profile', event })
    }
    if (all.length > 100_000) throw new Error('reconciliation window exceeds record limit')
    return all.filter(record => deviceSyncPacketByteLength({ v: 1, type: 'historyRecords', session: '0'.repeat(32), records: [record], requested: [] }) <= DEVICE_SYNC_MAX_PACKET_BYTES)
  }
  return {
    recordInventory: async (scope: DeviceSyncScope, since: number, until: number, initiator: boolean) => {
      const inventory = (await records(scope, since, until)).map(record => ({ id: deviceSyncRecordId(record), createdAt: deviceSyncRecordTime(record) }))
      if (scope === 'history' && initiator) for (const tombstone of await deletedHistoryRecords()) {
        if (tombstone.createdAt >= since && tombstone.createdAt <= until) inventory.push({ id: historyRecordId(tombstone), createdAt: tombstone.createdAt })
      }
      return inventory
    },
    records: async (scope: DeviceSyncScope, since: number, until: number, ids: string[], peer: string, linkId?: string) => {
      const requested = new Set(ids)
      const selected = (await records(scope, since, until)).filter(record => requested.has(deviceSyncRecordId(record)))
      if (scope === 'history' && options.allowsLegacy(peer, since, until, linkId)) {
        for (const record of selected) if (record.type === 'message') record.message = await withLegacyReactions(record.message)
      }
      return selected
    },
    applyRecords: async (peer: string, incoming: DeviceSyncRecord[], scope: DeviceSyncScope, since: number, until: number, linkId: string | undefined, authorized: () => boolean) => {
      let imported = 0
      // Current group state establishes contact/admin scope before other state records.
      const groups = incoming.flatMap(record => record.type === 'group' ? [record.group] : [])
      if (scope === 'state' && groups.length) await options.applySnapshot({ v: 1, type: 'snapshot', rosterAt: 0, appKeys: [], chats: [], groups, messages: [] }, undefined, authorized)
      const contacts = scope === 'state' ? (await state()).contacts : new Set<string>()
      for (const record of incoming) {
        if (!authorized()) return imported
        if (scope === 'history' && record.type === 'message') {
          imported += await options.applySnapshot({ v: 1, type: 'snapshot', rosterAt: since, appKeys: [], chats: [], groups: [], messages: [record.message] }, since, authorized, options.allowsLegacy(peer, since, until, linkId))
        } else if (scope === 'history' && record.type === 'reaction') await applyReactionRecord(options.owner, record.reaction, authorized)
        else if (scope === 'state' && record.type === 'groupSettings') await applyGroupSettingsRecord(options.owner, record.settings, authorized)
        else if (scope === 'state' && record.type === 'profile') await applyProfileRecord(options.owner, record.event, contacts, authorized)
      }
      return imported
    },
  }
}

export async function withLegacyReactions(message: DeviceSyncMessage): Promise<DeviceSyncMessage> {
  const stored = await db.messages.get(message.id)
  if (stored?.sessionId !== message.chatId) return message
  const legacyReactions = Object.entries(stored.reactions ?? {}).flatMap(([emoji, authors]) => authors.map(author => ({ author, emoji })))
  return legacyReactions.length ? { ...message, legacyReactions: legacyReactions.slice(0, 256) } : message
}

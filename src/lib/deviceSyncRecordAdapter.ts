import { db, deletedHistoryRecords, isHistoryChatDeleted } from './storage'
import { reactionHeadPages, reactionHead, groupSettingsHeads, groupSettingsHead, signedProfileHeads, saveSignedProfileHead } from './deviceSyncRecordStore'
import { applyReactionRecord, applyGroupSettingsRecord, applyProfileRecord } from './deviceSyncRecordApply'
import { deviceSyncRecordId, deviceSyncRecordTime, type DeviceSyncRecord, type DeviceSyncScope } from './deviceSyncRecords'
import { historyRecordId, type DeviceRecordReference } from './deviceHistorySync'
import { deviceSyncPacketByteLength, DEVICE_SYNC_MAX_PACKET_BYTES, type DeviceSyncMessage, type DeviceSyncSnapshot } from './deviceSyncProtocol'
import type { Event } from 'nostr-tools'

export function createDeviceSyncRecordAdapter(options: {
  owner: string
  snapshots(): DeviceSyncSnapshot[]
  messages(since: number, until: number): DeviceSyncMessage[]
  cachedProfiles?(contacts: string[]): Promise<Event[]>
  allowsLegacy(peer: string, since: number, until: number, linkId?: string): boolean
  applySnapshot(packet: DeviceSyncSnapshot, since: number | undefined, authorized: () => boolean, legacy?: boolean): Promise<number>
}) {
  async function state() {
    const packets = options.snapshots(), contacts = new Set<string>(), chats = new Set<string>()
    for (const chat of packets.flatMap(packet => packet.chats)) if (!await isHistoryChatDeleted(chat.id)) { contacts.add(chat.id); chats.add(chat.id) }
    const groups = []
    for (const group of packets.flatMap(packet => packet.groups)) if (!await isHistoryChatDeleted(`group:${group.id}`)) {
      groups.push(group)
      if (group.members.includes(options.owner)) group.members.forEach(member => contacts.add(member))
    }
    return { groups, contacts, chats }
  }
  async function eligible(record: DeviceSyncRecord, current: Awaited<ReturnType<typeof state>>, inventory = false): Promise<boolean> {
    if (record.type === 'message' || record.type === 'reaction') {
      const value = record.type === 'message' ? record.message : record.reaction
      const targetId = record.type === 'message' ? record.message.id : record.reaction.messageId
      const group = value.chatId.startsWith('group:') ? current.groups.find(group => group.id === value.chatId.slice(6)) : undefined
      if (value.chatId.startsWith('group:') ? !group?.members.includes(options.owner) || !group.members.includes(value.author) :
        !current.chats.has(value.chatId) || value.author !== options.owner && value.author !== value.chatId) return false
      if (inventory) return true
      if (await db.sessionManager.get(`history-deleted-message:${targetId}`) || await isHistoryChatDeleted(value.chatId)) return false
      const target = await db.messages.get(targetId)
      return !(target?.expiresAt !== undefined && target.expiresAt <= Date.now() / 1000)
    }
    if (record.type === 'profile') return current.contacts.has(record.event.pubkey)
    if (record.type === 'groupSettings') { const settings = record.settings; return current.groups.some(group => group.id === settings.groupId && group.members.includes(options.owner) && group.admins.includes(settings.author)) }
    return current.groups.some(group => group.id === record.group.id)
  }
  async function* available(scope: DeviceSyncScope, since: number, until: number): AsyncGenerator<DeviceSyncRecord> {
    const current = await state()
    if (scope === 'history') {
      for (const message of options.messages(since, until)) { const record = { type: 'message' as const, message }; if (await eligible(record, current, true)) yield record }
      for await (const page of reactionHeadPages(options.owner)) {
        const [targets, deleted] = await Promise.all([
          db.messages.bulkGet(page.map(reaction => reaction.messageId)),
          db.sessionManager.bulkGet(page.map(reaction => `history-deleted-message:${reaction.messageId}`)),
        ])
        for (const [index, reaction] of page.entries()) {
          if (reaction.createdAt < since || reaction.createdAt > until || deleted[index] ||
            targets[index]?.expiresAt !== undefined && targets[index]!.expiresAt! <= Date.now() / 1000 ||
            !await eligible({ type: 'reaction', reaction }, current, true)) continue
          yield { type: 'reaction', reaction }
        }
      }
    } else {
      for (const group of current.groups) yield { type: 'group', group }
      const groups = new Map(current.groups.map(group => [group.id, group]))
      for await (const settings of groupSettingsHeads(options.owner)) {
        if (groups.get(settings.groupId)?.members.includes(options.owner) && groups.get(settings.groupId)?.admins.includes(settings.author)) yield { type: 'groupSettings', settings }
      }
      const contacts = [...current.contacts]
      for (let index = 0; index < contacts.length; index += 64) {
        const batch = new Set(contacts.slice(index, index + 64))
        // Backfill only original heads already in this device's local event cache.
        for (const event of await options.cachedProfiles?.([...batch]) ?? []) await saveSignedProfileHead(options.owner, event, batch)
        for (const event of await signedProfileHeads(options.owner, batch)) yield { type: 'profile', event }
      }
    }
  }
  const bounded = (record: DeviceSyncRecord) => deviceSyncPacketByteLength({ v: 1, type: 'historyRecords', session: '0'.repeat(32), records: [record], requested: [] }) <= DEVICE_SYNC_MAX_PACKET_BYTES
  function reference(record: DeviceSyncRecord): DeviceRecordReference {
    const key = record.type === 'message' ? [record.message.chatId, record.message.id] : record.type === 'reaction' ? [record.reaction.chatId, record.reaction.messageId, record.reaction.author] :
      record.type === 'group' ? [record.group.id] : record.type === 'groupSettings' ? [record.settings.groupId] : [record.event.pubkey]
    return { id: deviceSyncRecordId(record), createdAt: deviceSyncRecordTime(record), locator: { type: record.type, key } }
  }
  async function lookup(ref: DeviceRecordReference): Promise<DeviceSyncRecord | undefined> {
    const locator = ref.locator
    if (!locator) return
    const [first, second, third] = locator.key
    if (locator.type === 'message') {
      const stored = await db.messages.get(second)
      if (!stored || stored.sessionId !== first || stored.call || stored.id.startsWith('call:') || stored.expiresAt !== undefined && stored.expiresAt <= Date.now() / 1000) return
      return { type: 'message', message: { chatId: first, id: stored.id, body: stored.content, createdAt: Math.floor(stored.timestamp / 1000),
        author: stored.isMine ? options.owner : stored.senderPubkey ?? first, ...(stored.expiresAt !== undefined && { expiresAt: stored.expiresAt }) } }
    }
    if (locator.type === 'reaction') { const reaction = await reactionHead(options.owner, { chatId: first, messageId: second, author: third }); return reaction && { type: 'reaction', reaction } }
    if (locator.type === 'groupSettings') { const settings = await groupSettingsHead(options.owner, first); return settings && { type: 'groupSettings', settings } }
    if (locator.type === 'profile') { const event = (await signedProfileHeads(options.owner, new Set([first])))[0]; return event && { type: 'profile', event } }
    const group = options.snapshots().flatMap(packet => packet.groups).find(group => group.id === first)
    return group && { type: 'group', group }
  }
  return {
    recordInventory: async (scope: DeviceSyncScope, since: number, until: number, initiator: boolean, prefix = '') => {
      const inventory: DeviceRecordReference[] = []
      for await (const record of available(scope, since, until)) {
        const ref = reference(record)
        if (ref.id.startsWith(prefix) && bounded(record)) inventory.push(ref)
        if (inventory.length > 100_000) throw new Error('reconciliation window exceeds record limit')
      }
      if (scope === 'history' && initiator) for await (const tombstone of deletedHistoryRecords()) {
        const id = historyRecordId(tombstone)
        if (id.startsWith(prefix) && tombstone.createdAt >= since && tombstone.createdAt <= until) inventory.push({ id, createdAt: tombstone.createdAt })
        if (inventory.length > 100_000) throw new Error('reconciliation window exceeds record limit')
      }
      return inventory
    },
    records: async (scope: DeviceSyncScope, since: number, until: number, refs: DeviceRecordReference[], peer: string, linkId?: string) => {
      const selected: DeviceSyncRecord[] = [], current = await state()
      for (const ref of refs) {
        let record = await lookup(ref)
        if (!record || deviceSyncRecordId(record) !== ref.id || !bounded(record) || !await eligible(record, current)) continue
        if (deviceSyncRecordTime(record) < since || deviceSyncRecordTime(record) > until) continue
        if (record.type === 'message' && scope === 'history' && options.allowsLegacy(peer, since, until, linkId)) record = { ...record, message: await withLegacyReactions(record.message) }
        if (bounded(record)) selected.push(record)
      }
      return selected
    },
    applyRecords: async (peer: string, incoming: DeviceSyncRecord[], scope: DeviceSyncScope, since: number, until: number, linkId: string | undefined, authorized: () => boolean) => {
      let imported = 0
      const groups = incoming.flatMap(record => record.type === 'group' ? [record.group] : [])
      if (scope === 'state' && groups.length) await options.applySnapshot({ v: 1, type: 'snapshot', rosterAt: 0, appKeys: [], chats: [], groups, messages: [] }, undefined, authorized)
      const contacts = scope === 'state' ? (await state()).contacts : new Set<string>()
      for (const record of incoming) {
        if (!authorized()) return imported
        if (scope === 'history' && record.type === 'message') imported += await options.applySnapshot({ v: 1, type: 'snapshot', rosterAt: since, appKeys: [], chats: [], groups: [], messages: [record.message] }, since, authorized, options.allowsLegacy(peer, since, until, linkId))
        else if (scope === 'history' && record.type === 'reaction') await applyReactionRecord(options.owner, record.reaction, authorized)
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
  const result = { ...message, legacyReactions: legacyReactions.slice(0, 256) }
  while (result.legacyReactions.length && deviceSyncPacketByteLength({ v: 1, type: 'historyRecords', session: '0'.repeat(32), requested: [], records: [{ type: 'message', message: result }] }) > DEVICE_SYNC_MAX_PACKET_BYTES) result.legacyReactions.pop()
  return result.legacyReactions.length ? result : message
}

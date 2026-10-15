import { writable } from 'svelte/store'
import type { PrivateEvent } from 'nostr-social-graph/privateEvents'
import { db } from './storage'
import { deviceRecordVersion } from './deviceSyncRecordStore'
import { mentionSetting, mentionSettingKey, mentionSettingsPrefix, newerMentionSetting } from './mentionNotificationPolicy'
export const mentionNotificationRecordVersion = writable(0)
export async function* mentionNotificationEvents(owner: string): AsyncGenerator<PrivateEvent> {
  const prefix = mentionSettingsPrefix(owner)
  let after: string | undefined
  while (true) {
    const rows = await db.sessionManager.where('key').between(after ?? prefix, prefix + '\uffff', after === undefined, true).limit(128).toArray()
    for (const row of rows) { try { mentionSetting(row.value as PrivateEvent,owner); yield row.value as PrivateEvent } catch { /* Ignore malformed persisted state. */ } }
    if (rows.length < 128) return
    after = rows.at(-1)!.key
  }
}
export async function mergeMentionNotificationEvent(owner: string, event: PrivateEvent, authorized: () => boolean): Promise<void> {
  const state = mentionSetting(event,owner)
  const changed = await db.transaction('rw',db.sessionManager,async () => {
    if (!authorized()) throw new Error('Account changed')
    const key = mentionSettingKey(owner,state.chatId), previous = (await db.sessionManager.get(key))?.value as PrivateEvent | undefined
    if (!newerMentionSetting(state,previous && mentionSetting(previous,owner))) return false
    await db.sessionManager.put({key,value:event}); return true
  })
  if (!changed) return
  deviceRecordVersion.update(n => n + 1)
  mentionNotificationRecordVersion.update(n => n + 1)
}

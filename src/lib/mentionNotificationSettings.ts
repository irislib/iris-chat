import { get, writable } from 'svelte/store'
import { buildPrivateSetting, type PrivateEvent } from 'nostr-social-graph/privateEvents'
import { db } from './storage'
import { identity } from './identity'
import { mentionNotificationEvents, mergeMentionNotificationEvent, mentionNotificationRecordVersion } from './mentionNotificationRecords'
import { mentionSetting, mentionSettingKey, type MentionNotificationSetting } from './mentionNotificationPolicy'
export const mentionNotificationSettings = writable<Record<string, MentionNotificationSetting>>({})
let activeOwner: string | null = null
let generation = 0
let loading = Promise.resolve()
export function loadMentionNotificationSettings(owner: string | null, force = false): Promise<void> {
  if (activeOwner === owner && !force) return loading
  if (activeOwner !== owner) mentionNotificationSettings.set({})
  activeOwner = owner; const token = ++generation
  loading = (async () => {
    if (!owner) return
    const states: Record<string,MentionNotificationSetting> = {}
    for await (const event of mentionNotificationEvents(owner)) { const state = mentionSetting(event,owner); states[state.chatId] = state }
    if (token === generation && get(identity)?.pubkey === owner) mentionNotificationSettings.set(states)
  })()
  return loading
}
mentionNotificationRecordVersion.subscribe(() => {
  const owner = activeOwner
  if (owner && get(identity)?.pubkey === owner) void loadMentionNotificationSettings(owner,true)
    .then(() => import('./notifications')).then(({updateDMSubscription})=>updateDMSubscription()).catch(()=>{})
})
export async function setMentionNotifications(chatId: string, enabled: boolean): Promise<void> {
  const owner = get(identity)?.pubkey
  if (!owner || !navigator.locks) throw new Error('Private sync is unavailable')
  await loadMentionNotificationSettings(owner)
  await navigator.locks.request(mentionSettingKey(owner,chatId),async () => {
    const old = (await db.sessionManager.get(mentionSettingKey(owner,chatId)))?.value as PrivateEvent | undefined
    const value = {chatId,enabled,updatedAtMs:Math.max(Date.now(),old ? mentionSetting(old,owner).updatedAtMs + 1 : 0)}
    await mergeMentionNotificationEvent(owner,buildPrivateSetting(owner,'mentionNotifications',chatId,value),()=>get(identity)?.pubkey === owner)
  })
}

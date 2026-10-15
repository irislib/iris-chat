import { mentionSetting } from './mentionNotificationPolicy'
import { validRequestDecision, requestDecisionStates } from './messageRequests'
import { buildPrivateSetting, parsePrivateSetting, type PrivateEvent } from 'nostr-social-graph/privateEvents'
import { isChatPinState } from './chatPinSync'
import { isChatMuteState } from './chatMuteSync'
import { validPrivateDeviceLabel } from './privateDeviceLabelProtocol'
import type { DeviceSyncSnapshot } from './deviceSyncProtocol'
const chat = (id: unknown): id is string => typeof id === 'string' && (/^[a-f0-9]{64}$/.test(id) || /^group:[^\x00-\x20]{1,128}$/.test(id))
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= Date.now() / 1000 + 300

export function privateSettingSnapshot(event: PrivateEvent, owner: string): DeviceSyncSnapshot {
  if (JSON.stringify(event).length > 8192) throw new Error('Private setting too large')
  const { setting, target, value } = parsePrivateSetting(event, owner)
  const packet: DeviceSyncSnapshot = { v: 1, type: 'snapshot', rosterAt: 0, chats: [], appKeys: [], groups: [], messages: [] }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid private setting value')
  if (setting === 'mentionNotifications') mentionSetting(event, owner)
  else if (setting === 'chatPin' && Object.keys(value).length === 3 && isChatPinState(value) && value.chatId === target && value.updatedAtMs <= Date.now() + 300_000) packet.chatPins = [value]
  else if (setting === 'chatMute' && Object.keys(value).length === 3 && isChatMuteState(value) && value.chatId === target && value.updatedAtMs <= Date.now() + 300_000) packet.chatMutes = [value]
  else if (setting === 'deviceLabel' && validPrivateDeviceLabel(value, owner) && value.device === target) packet.privateDeviceLabelsV2 = [value]
  else if (setting === 'chat' && chat(target) && value.id === target && time(value.updatedAt) && Object.keys(value).length === 2) packet.chats = [value]
  else if (setting === 'chatDeletion' && chat(target) && value.id === target && time(value.deletedAt) && value.deletedAt > 0 && Object.keys(value).length === 2) packet.deletedChats = [value]
  else if (setting === 'requestDecision' && validRequestDecision(value) && value.chatId === target) packet.requestDecisions = [value]
  else throw new Error('Unknown or invalid private setting')
  return packet
}

export async function* privateSettingEvents(owner: string, snapshots: DeviceSyncSnapshot[]): AsyncGenerator<PrivateEvent> {
  const events = new Map<string, PrivateEvent>()
  const add = (setting: string, target: string, value: unknown) => {
    const event = buildPrivateSetting(owner, setting, target, value)
    privateSettingSnapshot(event, owner)
    events.set(event.id, event)
  }
  for (const packet of snapshots) {
    for (const value of packet.chatPins ?? []) add('chatPin', value.chatId, value)
    for (const value of packet.chatMutes ?? []) add('chatMute', value.chatId, value)
    for (const value of packet.privateDeviceLabelsV2 ?? []) add('deviceLabel', value.device, value)
    for (const value of packet.chats) add('chat', value.id, { id: value.id, updatedAt: value.updatedAt })
  }
  const { chatDeletionStates } = await import('./storage')
  for (const value of await chatDeletionStates()) add('chatDeletion', value.id, value)
  for (const value of requestDecisionStates(owner)) add('requestDecision', value.chatId, value)
  const { mentionNotificationEvents } = await import('./mentionNotificationRecords')
  for await (const event of mentionNotificationEvents(owner)) events.set(event.id,event)
  yield* events.values()
}

import { parsePrivateSetting, type PrivateEvent } from 'nostr-social-graph/privateEvents'
import { mentionsOwner } from './mentions'
import { isChatMuted, type ChatMutes } from './chatMutePolicy'
export interface MentionNotificationSetting { chatId: string; enabled: boolean; updatedAtMs: number }
export const mentionSettingsPrefix = (owner: string) => `mention-notifications:${owner}:`
export const mentionSettingKey = (owner: string, chat: string) => mentionSettingsPrefix(owner) + chat
export function mentionSetting(event: PrivateEvent, owner: string): MentionNotificationSetting {
  const { setting, target, value } = parsePrivateSetting(event, owner)
  if (setting !== 'mentionNotifications' || !/^group:[^\x00-\x20]{1,128}$/.test(target) || !value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== 3 || value.chatId !== target || typeof value.enabled !== 'boolean' ||
    !Number.isSafeInteger(value.updatedAtMs) || value.updatedAtMs <= 0 || value.updatedAtMs > Date.now() + 300_000) throw new Error('Invalid mention setting')
  return value as MentionNotificationSetting
}
export function newerMentionSetting(next: MentionNotificationSetting, current?: MentionNotificationSetting) {
  return !current || next.updatedAtMs > current.updatedAtMs || next.updatedAtMs === current.updatedAtMs && !next.enabled && current.enabled
}
/** Only a genuinely silent-capable push subscription can classify muted groups locally. */
export function subscriptionMutes(mutes: ChatMutes, settings: Record<string, MentionNotificationSetting>, supportsSilentPush = false): ChatMutes {
  return Object.fromEntries(Object.entries(mutes).filter(([chat]) => !supportsSilentPush || !chat.startsWith('group:') || settings[chat]?.enabled === false))
}
export function shouldNotifyMutedMessage(mutes: ChatMutes, chat: string, content: string, owner: string, enabled = true, kind = 14): boolean {
  return !isChatMuted(mutes, chat) || chat.startsWith('group:') && enabled && kind === 14 && mentionsOwner(content, owner)
}

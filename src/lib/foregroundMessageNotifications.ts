import { get } from 'svelte/store'
import { identity } from './identity'
import { notificationSettings } from './notificationStore'
import { chatMutes, loadChatMutes } from './chatMuteStore'
import { loadMentionNotificationSettings, mentionNotificationSettings } from './mentionNotificationSettings'
import { shouldNotifyMutedMessage } from './mentionNotificationPolicy'
import { showUnreadNotification } from './readNotifications'
import { renderRumor } from './pushRumorRender'
import { mentionNames } from './mentionNames'
import type { StoredMessage } from './storage'
import { messageNotificationAllowed } from './messageNotificationPolicy'

/** Relay delivery can notify while the app is running, without a silent Web Push. */
export async function notifyForegroundMessage(owner: string, message: StoredMessage): Promise<void> {
  if (message.isMine || message.status === 'seen' || !get(notificationSettings).enabled || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  await Promise.all([loadChatMutes(owner),loadMentionNotificationSettings(owner)])
  if (get(identity)?.pubkey !== owner || !await messageNotificationAllowed(owner,{chatId:message.sessionId,messageId:message.id,author:message.senderPubkey ?? message.sessionId,createdAtSecs:Math.floor(message.timestamp/1000),expiresAt:message.expiresAt,deletedAt:message.deletedAt})) return
  if (!shouldNotifyMutedMessage(get(chatMutes),message.sessionId,message.content,owner,get(mentionNotificationSettings)[message.sessionId]?.enabled !== false)) return
  const [{currentChat,chats},{currentGroupId,groups}] = await Promise.all([import('./chat'),import('./groups')])
  if (!message.sessionId.startsWith('group:')) {
    const {getMessageRequestPolicyContext,isChatAccepted,isChatRejected} = await import('./messageRequestPolicy')
    const chat = get(chats).get(message.sessionId)
    const policy = getMessageRequestPolicyContext()
    if (!chat || isChatRejected(chat.recipientPubkey,policy) || !isChatAccepted(chat,policy)) return
  }
  const open = message.sessionId.startsWith('group:') ? get(currentGroupId) === message.sessionId.slice(6) : get(currentChat)?.id === message.sessionId
  if (document.visibilityState === 'visible' && document.hasFocus() && open) return
  const registration = await navigator.serviceWorker?.getRegistration()
  if (!registration || get(identity)?.pubkey !== owner) return
  const name = message.sessionId.startsWith('group:') ? get(groups).get(message.sessionId.slice(6))?.name : get(mentionNames([message.sessionId]))[message.sessionId]
  await showUnreadNotification(registration,{ownerPubkey:owner,chatId:message.sessionId,messageId:message.id,createdAtSecs:Math.floor(message.timestamp/1000)},
    name || 'iris chat',{body:renderRumor(14,message.content)?.body,tag:`dm-${message.sessionId}`})
}

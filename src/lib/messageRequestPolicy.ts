import { get } from 'svelte/store'
import { getPubkey } from './identity'
import { following } from './following'
import { messageRequests } from './messageRequests'
import { messageRequestSettings } from './messageRequestSettings'

export type MessageRequestChatLike = {
  recipientPubkey: string
  messages: Array<{ isMine: boolean }>
}

export type MessageRequestPolicyContext = {
  myPubkey: string | null
  following: Set<string>
  acceptedChats: Record<string, true | undefined>
  rejectedChats: Record<string, true | undefined>
  receiveMessageRequests: boolean
}

export function getMessageRequestPolicyContext(): MessageRequestPolicyContext {
  const decisions = get(messageRequests)
  return {
    myPubkey: getPubkey(),
    following: get(following),
    acceptedChats: decisions.acceptedChats,
    rejectedChats: decisions.rejectedChats,
    receiveMessageRequests: get(messageRequestSettings).receiveMessageRequests,
  }
}

export function isChatRejected(pubkey: string, ctx: MessageRequestPolicyContext): boolean {
  if (!pubkey) return false
  return !!ctx.rejectedChats?.[pubkey]
}

export function isChatAccepted(chat: MessageRequestChatLike, ctx: MessageRequestPolicyContext): boolean {
  const pubkey = chat?.recipientPubkey
  if (!pubkey) return false

  if (ctx.myPubkey && pubkey === ctx.myPubkey) return true
  if (ctx.following?.has(pubkey)) return true
  if (ctx.acceptedChats?.[pubkey]) return true

  // Treat chats we've already sent to as accepted.
  for (const msg of chat.messages || []) {
    if (msg.isMine) return true
  }

  return false
}

export function isMessageRequestChat(chat: MessageRequestChatLike, ctx: MessageRequestPolicyContext): boolean {
  const pubkey = chat?.recipientPubkey
  if (!pubkey) return false
  if (isChatRejected(pubkey, ctx)) return false
  if (isChatAccepted(chat, ctx)) return false

  // A request is an inbound chat we haven't engaged with yet.
  for (const msg of chat.messages || []) {
    if (!msg.isMine) return true
  }

  return false
}

export function shouldIgnoreIncomingEvent(
  chat: MessageRequestChatLike,
  isMine: boolean,
  ctx: MessageRequestPolicyContext
): boolean {
  if (isMine) return false
  const pubkey = chat?.recipientPubkey
  if (!pubkey) return false
  if (isChatAccepted(chat, ctx)) return false
  if (isChatRejected(pubkey, ctx)) return true
  return ctx.receiveMessageRequests === false
}


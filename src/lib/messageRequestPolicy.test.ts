import { describe, it, expect } from 'vitest'
import {
  isChatAccepted,
  isMessageRequestChat,
  shouldIgnoreIncomingEvent,
  type MessageRequestChatLike,
  type MessageRequestPolicyContext,
} from './messageRequestPolicy'

function ctx(partial?: Partial<MessageRequestPolicyContext>): MessageRequestPolicyContext {
  return {
    myPubkey: 'm'.repeat(64),
    following: new Set<string>(),
    acceptedChats: {},
    rejectedChats: {},
    receiveMessageRequests: true,
    ...partial,
  }
}

describe('messageRequestPolicy', () => {
  it('treats followed users as accepted', () => {
    const chat: MessageRequestChatLike = {
      recipientPubkey: 'f'.repeat(64),
      messages: [{ isMine: false }],
    }
    const c = ctx({ following: new Set([chat.recipientPubkey]) })
    expect(isChatAccepted(chat, c)).toBe(true)
    expect(isMessageRequestChat(chat, c)).toBe(false)
  })

  it('treats chats with outgoing messages as accepted', () => {
    const chat: MessageRequestChatLike = {
      recipientPubkey: 'u'.repeat(64),
      messages: [{ isMine: true }],
    }
    const c = ctx()
    expect(isChatAccepted(chat, c)).toBe(true)
    expect(isMessageRequestChat(chat, c)).toBe(false)
  })

  it('classifies unknown inbound chats as requests', () => {
    const chat: MessageRequestChatLike = {
      recipientPubkey: 'x'.repeat(64),
      messages: [{ isMine: false }],
    }
    const c = ctx()
    expect(isChatAccepted(chat, c)).toBe(false)
    expect(isMessageRequestChat(chat, c)).toBe(true)
  })

  it('does not classify rejected chats as requests', () => {
    const chat: MessageRequestChatLike = {
      recipientPubkey: 'r'.repeat(64),
      messages: [{ isMine: false }],
    }
    const c = ctx({ rejectedChats: { [chat.recipientPubkey]: true } })
    expect(isMessageRequestChat(chat, c)).toBe(false)
  })

  it('ignores incoming request events when disabled', () => {
    const chat: MessageRequestChatLike = {
      recipientPubkey: 'x'.repeat(64),
      messages: [],
    }
    const c = ctx({ receiveMessageRequests: false })
    expect(shouldIgnoreIncomingEvent(chat, false, c)).toBe(true)
  })

  it('does not ignore incoming events for accepted chats even when disabled', () => {
    const chat: MessageRequestChatLike = {
      recipientPubkey: 'x'.repeat(64),
      messages: [{ isMine: true }],
    }
    const c = ctx({ receiveMessageRequests: false })
    expect(shouldIgnoreIncomingEvent(chat, false, c)).toBe(false)
  })
})


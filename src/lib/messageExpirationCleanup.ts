import { get } from 'svelte/store'
import {
  getExpirationTimestampSeconds,
  isExpired,
} from 'nostr-double-ratchet'
import { chats, currentChat, type ChatMessage } from './chat'
import { groupMessages } from './groups'
import { deleteMessage as deleteMessageFromDb } from './storage'

let started = false
let timeoutId: ReturnType<typeof setTimeout> | null = null

function messageToTaggedEvent(msg: ChatMessage): { tags?: string[][] } {
  // Messages in iris-chat don't store tags directly.
  // Expiration is stored via the expiresAt field on ChatMessage.
  if (msg.expiresAt) {
    return { tags: [['expiration', String(msg.expiresAt)]] }
  }
  return { tags: [] }
}

export function startMessageExpirationCleanup(): void {
  if (started) return
  started = true

  const tick = () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    let nextExpirationSeconds: number | undefined

    // Purge expired DM messages
    const currentChats = get(chats)
    for (const [sessionId, chatSession] of currentChats) {
      const expiredIds: string[] = []
      for (const msg of chatSession.messages) {
        const event = messageToTaggedEvent(msg)
        const exp = getExpirationTimestampSeconds(event)
        if (exp === undefined) continue
        if (isExpired(event, nowSeconds)) {
          expiredIds.push(msg.id)
        } else {
          nextExpirationSeconds =
            nextExpirationSeconds === undefined ? exp : Math.min(nextExpirationSeconds, exp)
        }
      }

      if (expiredIds.length > 0) {
        const idSet = new Set(expiredIds)
        const updatedMessages = chatSession.messages.filter((m) => !idSet.has(m.id))
        const updatedSession = { ...chatSession, messages: updatedMessages }

        chats.update((c) => {
          c.set(sessionId, updatedSession)
          return c
        })

        const current = get(currentChat)
        if (current?.id === sessionId) {
          currentChat.set(updatedSession)
        }

        for (const id of expiredIds) {
          deleteMessageFromDb(id)
        }
      }
    }

    // Purge expired group messages
    const currentGroupMessages = get(groupMessages)
    for (const [groupId, msgs] of currentGroupMessages) {
      const expiredIds: string[] = []
      for (const msg of msgs) {
        const event = messageToTaggedEvent(msg)
        const exp = getExpirationTimestampSeconds(event)
        if (exp === undefined) continue
        if (isExpired(event, nowSeconds)) {
          expiredIds.push(msg.id)
        } else {
          nextExpirationSeconds =
            nextExpirationSeconds === undefined ? exp : Math.min(nextExpirationSeconds, exp)
        }
      }

      if (expiredIds.length > 0) {
        const idSet = new Set(expiredIds)
        groupMessages.update((gm) => {
          const filtered = (gm.get(groupId) || []).filter((m) => !idSet.has(m.id))
          gm.set(groupId, filtered)
          return gm
        })

        for (const id of expiredIds) {
          deleteMessageFromDb(id)
        }
      }
    }

    // Schedule next tick
    const delayMs =
      nextExpirationSeconds === undefined
        ? 60_000
        : Math.max(1000, Math.min(60_000, (nextExpirationSeconds - nowSeconds) * 1000))

    timeoutId = setTimeout(tick, delayMs)
  }

  // Start first tick after a short delay to let stores hydrate
  timeoutId = setTimeout(tick, 2000)
}

export function stopMessageExpirationCleanup(): void {
  if (timeoutId !== null) {
    clearTimeout(timeoutId)
    timeoutId = null
  }
  started = false
}

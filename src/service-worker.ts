/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching'
import { Session, type Rumor, deserializeSessionState } from 'nostr-double-ratchet'
import type { VerifiedEvent } from 'nostr-tools'
import Dexie, { type Table } from 'dexie'
import { getAnimalName } from './lib/animalNames'

declare let self: ServiceWorkerGlobalScope

// Precache assets
precacheAndRoute(self.__WB_MANIFEST)

// Dexie DB for service worker (must match main app schema)
interface StoredSession {
  id: string
  recipientPubkey: string
  sessionState: string
  createdAt: number
}

interface StoredProfile {
  pubkey: string
  name?: string
  display_name?: string
  picture?: string
  updatedAt: number
}

interface StoredMessage {
  id: string
  sessionId: string
  content: string
  timestamp: number
  isMine: boolean
}

class IrisChatDB extends Dexie {
  sessions!: Table<StoredSession, string>
  messages!: Table<StoredMessage, string>
  profiles!: Table<StoredProfile, string>

  constructor() {
    super('iris-chat')
    this.version(1).stores({
      sessions: 'id',
      messages: 'id, sessionId',
      profiles: 'pubkey'
    })
  }
}

const db = new IrisChatDB()

// Get display name from profile, fallback to animal name
async function getDisplayName(pubkey: string): Promise<string> {
  try {
    const profile = await db.profiles.get(pubkey)
    if (profile) {
      const name = profile.display_name || profile.name
      if (name) return name
    }
  } catch (err) {
    console.error('[sw] error fetching profile:', err)
  }
  return getAnimalName(pubkey)
}

interface DecryptResult {
  success: boolean
  content?: string
  chatId?: string
}

// Find session and decrypt message
async function decryptPushMessage(eventData: { id?: string; pubkey: string; tags: string[][]; [key: string]: unknown }): Promise<DecryptResult> {
  const sessions = await db.sessions.toArray()

  for (const storedSession of sessions) {
    try {
      const state = deserializeSessionState(storedSession.sessionState)

      // Check if this message is from this session's peer
      if (state.theirCurrentNostrPublicKey !== eventData.pubkey &&
          state.theirNextNostrPublicKey !== eventData.pubkey) {
        continue
      }

      // Fast path: check if main app already decrypted and saved this message
      const outerId = eventData.id
      if (outerId) {
        const storedMessage = await db.messages.get(outerId)
        if (storedMessage && !storedMessage.isMine) {
          return {
            success: true,
            content: storedMessage.content,
            chatId: storedSession.recipientPubkey
          }
        }
      }

      // Slow path: try to decrypt using Session class
      const eventForSession: VerifiedEvent = {
        ...eventData as unknown as VerifiedEvent,
        tags: eventData.tags.filter(([key]) => key === 'header'),
      }

      let deliverToSession: ((event: VerifiedEvent) => void) | undefined
      const session = new Session((_, onEvent) => {
        deliverToSession = onEvent
        return () => { deliverToSession = undefined }
      }, state)

      const innerEvent = await new Promise<Rumor | null>((resolve) => {
        const timeout = setTimeout(() => resolve(null), 500)
        session.onEvent((rumor) => {
          clearTimeout(timeout)
          resolve(rumor)
        })
        if (deliverToSession) {
          try {
            deliverToSession(eventForSession)
          } catch {
            resolve(null)
          }
        }
      })

      if (innerEvent) {
        return {
          success: true,
          content: innerEvent.content,
          chatId: storedSession.recipientPubkey
        }
      }

      // Fallback: show generic notification with sender name
      return {
        success: false,
        chatId: storedSession.recipientPubkey
      }
    } catch (err) {
      console.error('[sw] decrypt error:', err)
    }
  }

  return { success: false }
}

// Check if a specific chat is currently open in any visible client
async function isChatOpen(chatId: string): Promise<boolean> {
  const clients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true
  })

  for (const client of clients) {
    if (client.visibilityState === 'visible') {
      // Ask client if this chat is open
      const channel = new MessageChannel()
      const response = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 100)
        channel.port1.onmessage = (e) => {
          clearTimeout(timeout)
          resolve(e.data?.isOpen === true)
        }
        client.postMessage({ type: 'IS_CHAT_OPEN', chatId }, [channel.port2])
      })
      if (response) return true
    }
  }
  return false
}

// Handle push notifications
self.addEventListener('push', (event) => {
  if (!event.data) return

  const handlePush = async () => {
    try {
      const payload = event.data?.json()
      if (!payload?.event) {
        await showFallbackNotification()
        return
      }

      const result = await decryptPushMessage(payload.event)

      if (result.chatId) {
        // Skip notification if this specific chat is already open
        if (await isChatOpen(result.chatId)) {
          return
        }

        const senderName = await getDisplayName(result.chatId)
        const body = result.success && result.content ? result.content : 'New message'
        await self.registration.showNotification(senderName, {
          body,
          icon: '/iris-logo.png',
          badge: '/iris-logo.png',
          tag: `dm-${result.chatId}`,
          data: { chatId: result.chatId }
        })
      } else {
        await showFallbackNotification()
      }
    } catch (error) {
      console.error('[sw] push error:', error)
      await showFallbackNotification()
    }
  }

  event.waitUntil(handlePush())
})

async function showFallbackNotification() {
  await self.registration.showNotification('iris chat', {
    body: 'You have a new message',
    icon: '/iris-logo.png',
    badge: '/iris-logo.png'
  })
}

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const handleClick = async () => {
    const chatId = event.notification.data?.chatId

    const windowClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    })

    // Try to focus an existing window
    for (const client of windowClients) {
      if (client.url.includes(self.location.origin) && 'focus' in client) {
        await client.focus()
        if (chatId) {
          client.postMessage({ type: 'NOTIFICATION_CLICK', chatId })
        }
        return
      }
    }

    // Open new window if no existing one
    await self.clients.openWindow('/')
  }

  event.waitUntil(handleClick())
})

// Handle activation - claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

// Listen for messages from client
self.addEventListener('message', (event) => {
  if (event.data?.type === 'CLEAR_NOTIFICATION' && event.data?.chatId) {
    // Clear notifications for this chat
    self.registration.getNotifications({ tag: `dm-${event.data.chatId}` })
      .then(notifications => {
        notifications.forEach(n => n.close())
      })
  }
})

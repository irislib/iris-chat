/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching'
import { Session, type Rumor, type NostrSubscribe, deserializeSessionState, MESSAGE_EVENT_KIND, INVITE_RESPONSE_KIND } from 'nostr-double-ratchet'
import Dexie, { type Table } from 'dexie'
import { getAnimalName } from './lib/animalNames'
import { generateProxyUrl } from './lib/imgproxy'

declare let self: ServiceWorkerGlobalScope

type NostrEvent = Parameters<Parameters<NostrSubscribe>[1]>[0]

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

interface StoredInvite {
  id: string
  inviteData: string
  label?: string
  createdAt: number
}

interface ProcessedEvent {
  id: string
  kind: number
  chatId: string
  content?: string
  timestamp: number
}

class IrisChatDB extends Dexie {
  sessions!: Table<StoredSession, string>
  messages!: Table<StoredMessage, string>
  profiles!: Table<StoredProfile, string>
  invites!: Table<StoredInvite, string>
  processedEvents!: Table<ProcessedEvent, string>

  constructor() {
    super('iris-chat')
    this.version(1).stores({
      sessions: 'id',
      messages: 'id, sessionId',
      profiles: 'pubkey'
    })
    this.version(2).stores({
      sessions: 'id',
      messages: 'id, sessionId',
      profiles: 'pubkey',
      invites: 'id'
    })
    this.version(3).stores({
      sessions: 'id',
      messages: 'id, sessionId',
      profiles: 'pubkey',
      invites: 'id',
      processedEvents: 'id, timestamp'
    })
  }
}

const db = new IrisChatDB()

// Track currently open chat (only one can be open at a time)
let currentOpenChatId: string | null = null

// Get display info from profile
async function getSenderInfo(pubkey: string): Promise<{ name: string; icon: string }> {
  const fallbackIcon = '/iris-logo.png'
  try {
    const profile = await db.profiles.get(pubkey)
    if (profile) {
      const name = profile.display_name || profile.name || getAnimalName(pubkey)
      const icon = profile.picture
        ? await generateProxyUrl(profile.picture, { width: 96, height: 96, square: true })
        : fallbackIcon
      return { name, icon }
    }
  } catch (err) {
    console.error('[sw] error fetching profile:', err)
  }
  return { name: getAnimalName(pubkey), icon: fallbackIcon }
}

// Inner event kinds that should not trigger notifications
const KIND_REACTION = 7
const KIND_RECEIPT = 15
const KIND_TYPING = 25

interface DecryptResult {
  success: boolean
  content?: string
  chatId?: string
  silent?: boolean
}

// Find session and decrypt message
async function decryptPushMessage(eventData: { id?: string; pubkey: string; tags: string[][]; [key: string]: unknown }): Promise<DecryptResult> {
  // Check if main app already processed this event
  if (eventData.id) {
    try {
      const processed = await db.processedEvents.get(eventData.id)
      if (processed) {
        if (processed.kind === KIND_TYPING || processed.kind === KIND_RECEIPT) {
          return { success: true, chatId: processed.chatId, silent: true }
        }
        if (processed.kind === KIND_REACTION) {
          return {
            success: true,
            content: `Reacted ${processed.content || ''}`,
            chatId: processed.chatId,
          }
        }
      }
    } catch (err) {
      console.error('[sw] error checking processedEvents:', err)
    }
  }

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
            chatId: storedSession.recipientPubkey,
          }
        }
      }

      // Slow path: try to decrypt using Session class
      const eventForSession: NostrEvent = {
        ...eventData as unknown as NostrEvent,
        tags: eventData.tags.filter(([key]) => key === 'header'),
      }

      let deliverToSession: ((event: NostrEvent) => void) | undefined
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
        // Suppress notifications for typing and receipts
        const silent = innerEvent.kind === KIND_RECEIPT ||
          innerEvent.kind === KIND_TYPING
        return {
          success: true,
          content: innerEvent.kind === KIND_REACTION
            ? `Reacted ${innerEvent.content}`
            : innerEvent.content,
          chatId: storedSession.recipientPubkey,
          silent,
        }
      }

      // Decryption failed - show generic notification since it could be a real message
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

// Check if a specific chat is currently open in a visible window
async function isChatOpen(chatId: string): Promise<boolean> {
  const clients = await self.clients.matchAll({ type: 'window' })

  // Find visible clients
  const visibleClients = clients.filter(c => c.visibilityState === 'visible')
  
  if (visibleClients.length === 0) {
    currentOpenChatId = null
    console.log('[sw] isChatOpen: no visible clients')
    return false
  }

  // Ask visible clients what chat is currently open
  // This handles the case where SW was restarted and lost in-memory state
  for (const client of visibleClients) {
    try {
      const channel = new MessageChannel()
      const response = await Promise.race([
        new Promise<string | null>((resolve) => {
          channel.port1.onmessage = (e) => resolve(e.data?.chatId ?? null)
          client.postMessage({ type: 'GET_OPEN_CHAT' }, [channel.port2])
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 100))
      ])
      if (response !== null) {
        currentOpenChatId = response
      }
    } catch {
      // Client might not respond, continue
    }
  }

  console.log('[sw] isChatOpen check:', { chatId, currentOpenChatId, match: currentOpenChatId === chatId })
  return currentOpenChatId === chatId
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

      const eventKind = payload.event.kind

      // Handle invite response notifications
      if (eventKind === INVITE_RESPONSE_KIND) {
        console.log('[sw] received invite response notification')

        // Try to find the invite label from the p-tag (recipient pubkey)
        let inviteLabel: string | undefined
        const pTag = payload.event.tags?.find((t: string[]) => t[0] === 'p')
        if (pTag && pTag[1]) {
          const recipientPubkey = pTag[1]
          // Search invites for matching ephemeral pubkey
          try {
            const invites = await db.invites.toArray()
            for (const invite of invites) {
              // The invite data contains the ephemeral pubkey
              if (invite.inviteData.includes(recipientPubkey) && invite.label) {
                inviteLabel = invite.label
                break
              }
            }
          } catch (err) {
            console.error('[sw] error fetching invites:', err)
          }
        }

        const body = inviteLabel ? `New chat via ${inviteLabel}` : 'New chat via invite link'
        await self.registration.showNotification('iris chat', {
          body,
          icon: '/iris-logo.png',
          badge: '/iris-logo.png',
          tag: 'invite-response'
        })
        return
      }

      // Handle regular message notifications
      if (eventKind === MESSAGE_EVENT_KIND) {
        const result = await decryptPushMessage(payload.event)

        if (result.chatId) {
          // Skip notification if this specific chat is already open
          if (await isChatOpen(result.chatId)) {
            return
          }

          // Skip notifications for reactions, receipts, typing, etc.
          if (result.silent) {
            return
          }

          const sender = await getSenderInfo(result.chatId)
          let body: string
          if (result.success && result.content) {
            body = result.content
          } else {
            body = 'New message'
          }
          const tag = `dm-${result.chatId}`
          console.log('[sw] showing notification with tag:', tag)
          await self.registration.showNotification(sender.name, {
            body,
            icon: sender.icon,
            badge: '/iris-logo.png',
            tag,
            data: { chatId: result.chatId }
          })
        } else {
          await showFallbackNotification()
        }
        return
      }

      // Unknown event kind, show fallback
      await showFallbackNotification()
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
  const notification = event.notification
  console.log('[sw] notification clicked, tag:', notification.tag, 'data:', notification.data)

  const handleClick = async () => {
    // Close notification inside waitUntil for browser compatibility
    notification.close()
    console.log('[sw] notification closed')

    const chatId = notification.data?.chatId
    console.log('[sw] handling click for chatId:', chatId)

    const windowClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    })
    console.log('[sw] found window clients:', windowClients.length)

    // Try to focus an existing window
    for (const client of windowClients) {
      console.log('[sw] client url:', client.url, 'origin:', self.location.origin)
      if (client.url.includes(self.location.origin) && 'focus' in client) {
        console.log('[sw] focusing client and sending NOTIFICATION_CLICK')
        // Use the client returned by focus() for postMessage
        const focusedClient = await client.focus()
        if (chatId && focusedClient) {
          focusedClient.postMessage({ type: 'NOTIFICATION_CLICK', chatId })
        }
        return
      }
    }

    // Open new window if no existing one
    const url = chatId ? `/#chat-${chatId}` : '/'
    console.log('[sw] no existing window, opening:', url)
    await self.clients.openWindow(url)
  }

  event.waitUntil(handleClick())
})

// Skip waiting to activate new SW immediately
self.addEventListener('install', () => {
  self.skipWaiting()
})

// Handle activation - claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

// Listen for messages from client
self.addEventListener('message', (event) => {
  if (event.data?.type === 'CHAT_OPENED') {
    console.log('[sw] CHAT_OPENED received:', event.data.chatId)
    currentOpenChatId = event.data.chatId || null
  }

  if (event.data?.type === 'CLEAR_NOTIFICATION' && event.data?.chatId) {
    const tag = `dm-${event.data.chatId}`
    // Clear notifications for this chat
    self.registration.getNotifications({ tag })
      .then(notifications => notifications.forEach(n => n.close()))
    // Also try without tag filter as fallback
    self.registration.getNotifications()
      .then(notifications => notifications.filter(n => n.tag === tag).forEach(n => n.close()))
  }
})

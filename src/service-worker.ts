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

class IrisChatDB extends Dexie {
  sessions!: Table<StoredSession, string>
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
    console.error('[service-worker] error fetching profile:', err)
  }
  return getAnimalName(pubkey)
}

interface DecryptResult {
  success: boolean
  content?: string
  chatId?: string
}

// Find session and decrypt message
async function decryptPushMessage(eventData: { pubkey: string; tags: string[][]; [key: string]: unknown }): Promise<DecryptResult> {
  const sessions = await db.sessions.toArray()
  console.log('[service-worker] checking', sessions.length, 'sessions for pubkey:', eventData.pubkey)

  for (const storedSession of sessions) {
    try {
      const state = deserializeSessionState(storedSession.sessionState)
      console.log('[service-worker] session', storedSession.recipientPubkey,
        'theirCurrent:', state.theirCurrentNostrPublicKey,
        'theirNext:', state.theirNextNostrPublicKey)

      if (state.theirCurrentNostrPublicKey !== eventData.pubkey &&
          state.theirNextNostrPublicKey !== eventData.pubkey) {
        console.log('[service-worker] pubkey mismatch, skipping')
        continue
      }

      console.log('[service-worker] found matching session, attempting decrypt')

      // Found matching session - try to decrypt
      const eventForSession: VerifiedEvent = {
        ...eventData as unknown as VerifiedEvent,
        tags: eventData.tags.filter(([key]) => key === 'header'),
      }
      console.log('[service-worker] event for session:', JSON.stringify(eventForSession))

      let deliverToSession: ((event: VerifiedEvent) => void) | undefined
      const session = new Session((filter, onEvent) => {
        console.log('[service-worker] Session requested subscription with filter:', filter)
        deliverToSession = onEvent
        return () => { deliverToSession = undefined }
      }, state)

      const innerEvent = await new Promise<Rumor | null>((resolve) => {
        const timeout = setTimeout(() => {
          console.log('[service-worker] decrypt timeout')
          resolve(null)
        }, 1500)
        const unsub = session.onEvent((rumor) => {
          console.log('[service-worker] decrypted rumor:', rumor)
          clearTimeout(timeout)
          resolve(rumor)
        })
        console.log('[service-worker] onEvent registered, unsub:', typeof unsub)
        if (deliverToSession) {
          console.log('[service-worker] delivering event to session...')
          try {
            deliverToSession(eventForSession)
            console.log('[service-worker] event delivered')
          } catch (e) {
            console.error('[service-worker] error delivering event:', e)
            resolve(null)
          }
        } else {
          console.log('[service-worker] deliverToSession not ready')
        }
      })

      if (innerEvent) {
        return {
          success: true,
          content: innerEvent.content,
          chatId: storedSession.recipientPubkey
        }
      } else {
        console.log('[service-worker] decrypt returned null, but session matched')
        // Decrypt failed but we know who it's from
        return {
          success: false,
          chatId: storedSession.recipientPubkey
        }
      }
    } catch (err) {
      console.error('[service-worker] decrypt error:', err)
    }
  }

  return { success: false }
}

// Handle push notifications
self.addEventListener('push', (event) => {
  console.log('[service-worker] v2 push event received:', event)
  if (!event.data) {
    console.log('[service-worker] no push data')
    return
  }

  const handlePush = async () => {
    try {
      const payload = event.data?.json()
      console.log('[service-worker] push payload:', payload)
      console.log('[service-worker] event.content:', payload.event?.content)
      console.log('[service-worker] event.sig:', payload.event?.sig)
      console.log('[service-worker] event.tags:', payload.event?.tags)

      // Try to decrypt the message
      if (payload.event) {
        const result = await decryptPushMessage(payload.event)
        console.log('[service-worker] decrypt result:', result)

        // Show notification if we know who it's from (even if decrypt failed)
        if (result.chatId) {
          const senderName = await getDisplayName(result.chatId)
          const body = result.success && result.content ? result.content : 'New message'
          await self.registration.showNotification(senderName, {
            body,
            icon: '/iris-logo.png',
            badge: '/iris-logo.png',
            tag: `dm-${result.chatId}`,
            data: { chatId: result.chatId }
          })
          console.log('[service-worker] notification shown:', senderName, body)
          return
        }
      }

      // Fallback notification
      await self.registration.showNotification('iris chat', {
        body: 'You have a new message',
        icon: '/iris-logo.png',
        badge: '/iris-logo.png'
      })
      console.log('[service-worker] fallback notification shown')
    } catch (error) {
      console.error('[service-worker] Error handling push notification:', error)
      await self.registration.showNotification('iris chat', {
        body: 'You have a new message',
        icon: '/iris-logo.png',
        badge: '/iris-logo.png'
      })
    }
  }

  event.waitUntil(handlePush())
})

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const handleClick = async () => {
    const chatId = event.notification.data?.chatId

    // Focus existing window or open new one
    const windowClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    })

    // Try to focus an existing window
    for (const client of windowClients) {
      if (client.url.includes(self.location.origin) && 'focus' in client) {
        await client.focus()
        // Navigate to the specific chat
        if (chatId) {
          client.postMessage({
            type: 'NOTIFICATION_CLICK',
            chatId
          })
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

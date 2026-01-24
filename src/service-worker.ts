/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching'

declare let self: ServiceWorkerGlobalScope

// Precache assets
precacheAndRoute(self.__WB_MANIFEST)

// Database constants - must match storage.ts
const DB_NAME = 'iris-chat'
const DB_VERSION = 1
const SESSIONS_STORE = 'sessions'

interface StoredSession {
  id: string
  recipientPubkey: string
  sessionState: string
  createdAt: number
}

// Helper to convert base64 to Uint8Array
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// Deserialize session state, converting base64 back to Uint8Arrays
function deserializeSessionState(json: string): unknown {
  return JSON.parse(json, (_key, value) => {
    if (value && typeof value === 'object' && value.__type === 'Uint8Array') {
      return base64ToUint8Array(value.data)
    }
    return value
  })
}

// Open IndexedDB
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
}

// Get session by recipient pubkey
async function getSessionByRecipient(recipientPubkey: string): Promise<StoredSession | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SESSIONS_STORE, 'readonly')
    const store = tx.objectStore(SESSIONS_STORE)
    const request = store.getAll()
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const sessions = request.result as StoredSession[]
      const session = sessions.find(s => s.recipientPubkey === recipientPubkey)
      resolve(session || null)
    }
  })
}

// Handle push notifications
self.addEventListener('push', (event) => {
  console.log('[service-worker] push event received:', event)
  if (!event.data) {
    console.log('[service-worker] no push data')
    return
  }

  const handlePush = async () => {
    try {
      const payload = event.data?.json()
      console.log('[service-worker] push payload:', payload)

      // Expected payload format: { senderPubkey, encryptedContent, ... }
      const { senderPubkey, title, body } = payload

      // If we have pre-decrypted content from server, use it
      if (title && body) {
        await self.registration.showNotification(title, {
          body,
          icon: '/iris-logo.png',
          badge: '/iris-logo.png',
          tag: `dm-${senderPubkey}`,
          data: { senderPubkey }
        })
        return
      }

      // Try to get session and decrypt locally
      if (senderPubkey) {
        const session = await getSessionByRecipient(senderPubkey)

        if (session) {
          // Show notification with sender info
          // Note: Full decryption would require loading nostr-double-ratchet in SW
          // For now, show a generic notification
          await self.registration.showNotification('New Message', {
            body: 'You have a new encrypted message',
            icon: '/iris-logo.png',
            badge: '/iris-logo.png',
            tag: `dm-${senderPubkey}`,
            data: { senderPubkey }
          })
        } else {
          await self.registration.showNotification('New Message', {
            body: 'You have a new message',
            icon: '/iris-logo.png',
            badge: '/iris-logo.png'
          })
        }
      }
    } catch (error) {
      console.error('Error handling push notification:', error)
      // Show generic notification on error
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
    const senderPubkey = event.notification.data?.senderPubkey

    // Focus existing window or open new one
    const windowClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    })

    // Try to focus an existing window
    for (const client of windowClients) {
      if (client.url.includes(self.location.origin) && 'focus' in client) {
        await client.focus()
        // Optionally navigate to the chat
        if (senderPubkey) {
          client.postMessage({
            type: 'NOTIFICATION_CLICK',
            senderPubkey
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

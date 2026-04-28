// Notification utilities for iris-chat
import { get } from 'svelte/store'
import { identity, ndk } from './identity'
import { notificationSettings } from './notificationStore'
import { getInviteEphemeralPubkeys } from './chat'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getNdrRuntime } from './privateChats'

// NIP-98 HTTP Authentication event (KIND 27235)
const KIND_HTTP_AUTH = 27235

// Double ratchet message kinds - imported values from nostr-double-ratchet
import { MESSAGE_EVENT_KIND, INVITE_RESPONSE_KIND } from 'nostr-double-ratchet'

export interface WebPushSubscription {
  endpoint: string
  p256dh: string
  auth: string
}

export interface NotificationSubscription {
  id?: string
  webhooks: string[]
  web_push_subscriptions: WebPushSubscription[]
  filter: {
    ids?: string[]
    authors?: string[]
    kinds?: number[]
    search?: string
    '#p'?: string[]
  }
  subscriber: string
}

export interface NotificationSubscriptionResponse {
  [key: string]: NotificationSubscription
}

export class NotificationService {
  private baseUrl: string

  constructor(baseUrl?: string) {
    const settings = get(notificationSettings)
    // Ensure URL ends with /
    let url = baseUrl || settings.serverUrl
    if (!url.endsWith('/')) {
      url += '/'
    }
    this.baseUrl = url
  }

  async getInfo(): Promise<{ vapid_public_key: string }> {
    return this.getJson('info')
  }

  async getNotificationSubscriptions(): Promise<NotificationSubscriptionResponse> {
    return this.getJsonAuthd('subscriptions/')
  }

  async registerPushNotifications(
    web_push_subscriptions: WebPushSubscription[],
    filter: NotificationSubscription['filter']
  ): Promise<{ id: string; status: string }> {
    return this.getJsonAuthd('subscriptions', 'POST', {
      web_push_subscriptions,
      webhooks: [],
      filter
    })
  }

  async updateNotificationSubscription(
    id: string,
    subscription: Omit<NotificationSubscription, 'id'>
  ): Promise<{ status: string }> {
    return this.getJsonAuthd(`subscriptions/${id}`, 'POST', subscription)
  }

  async deleteNotificationSubscription(id: string): Promise<void> {
    return this.getJsonAuthd(`subscriptions/${id}`, 'DELETE')
  }

  private async getJsonAuthd<T>(
    path: string,
    method: string = 'GET',
    body?: object
  ): Promise<T> {
    const currentIdentity = get(identity)
    const ndkInstance = get(ndk)

    if (!currentIdentity || !ndkInstance.signer) {
      throw new Error('Not logged in')
    }

    const url = `${this.baseUrl}${path}`

    const event = new NDKEvent(ndkInstance)
    event.kind = KIND_HTTP_AUTH
    event.created_at = Math.floor(Date.now() / 1000)
    event.tags = [
      ['u', url],
      ['method', method]
    ]
    event.content = ''

    await event.sign()
    const nostrEvent = await event.toNostrEvent()
    const encodedEvent = btoa(JSON.stringify(nostrEvent))

    return this.getJson(path, method, body, {
      authorization: `Nostr ${encodedEvent}`
    })
  }

  private async getJson<T>(
    path: string,
    method: string = 'GET',
    body?: object,
    headers?: Record<string, string>
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers
      }
    })

    if (response.ok) {
      const text = await response.text()
      if (text.length > 0) {
        const obj = JSON.parse(text)
        if (typeof obj === 'object' && 'error' in obj) {
          throw new Error(obj.error)
        }
        return obj as T
      }
      return {} as T
    } else {
      const text = await response.text()
      throw new Error(`Request failed: ${response.status} ${text}`)
    }
  }
}

// Helper to encode ArrayBuffer as base64
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

// Cache for push subscription
let subscriptionPromise: Promise<PushSubscription | null> | null = null

// Cache for last synced authors - avoids unnecessary API calls
let lastSyncedAuthors: string[] = []
let lastSyncedInviteRecipients: string[] = []

// Get or create push subscription
export async function getOrCreatePushSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) {
    return null
  }

  if (Notification.permission !== 'granted') {
    return null
  }

  if (!subscriptionPromise) {
    subscriptionPromise = (async () => {
      const reg = await navigator.serviceWorker.ready
      let pushSubscription = await reg.pushManager.getSubscription()

      // Get VAPID key from server
      const settings = get(notificationSettings)
      const api = new NotificationService(settings.serverUrl)
      const { vapid_public_key: vapidKey } = await api.getInfo()

      // Check if we need to resubscribe due to different VAPID key
      if (pushSubscription) {
        const currentKey = pushSubscription.options.applicationServerKey
        if (currentKey) {
          const currentKeyBase64 = arrayBufferToBase64(currentKey)
          // Normalize both keys for comparison
          const normalizedCurrent = currentKeyBase64.replace(/[=]/g, '')
          const normalizedNew = vapidKey.replace(/-/g, '+').replace(/_/g, '/').replace(/[=]/g, '')

          if (normalizedCurrent !== normalizedNew) {
            await pushSubscription.unsubscribe()
            pushSubscription = null
          }
        }
      }

      if (!pushSubscription) {
        try {
          pushSubscription = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: vapidKey
          })
        } catch (err) {
          console.error('Failed to subscribe to push notifications:', err)
          return null
        }
      }

      return pushSubscription
    })()
  }

  return subscriptionPromise
}

// Extract session pubkeys from active chats
function getSessionAuthors(): string[] {
  const currentIdentity = get(identity)
  if (!currentIdentity) return []

  const authors: string[] = []

  const userRecords = getNdrRuntime().getSessionUserRecords()
  for (const [userPubkey, record] of userRecords.entries()) {
    // Skip self-sessions (our own devices) to avoid notifications for our own messages
    if (userPubkey === currentIdentity.pubkey) continue
    for (const device of record.devices?.values() ?? []) {
      const sessions = [
        ...(device.activeSession ? [device.activeSession] : []),
        ...(device.inactiveSessions ?? []),
      ]
      for (const session of sessions) {
        const state = session?.state
        if (!state) continue
        if (state.theirCurrentNostrPublicKey) {
          authors.push(state.theirCurrentNostrPublicKey)
        }
        if (state.theirNextNostrPublicKey) {
          authors.push(state.theirNextNostrPublicKey)
        }
      }
    }
  }

  return [...new Set(authors)]
}

// Get invite ephemeral pubkeys for notification subscription
function getInviteRecipients(): string[] {
  return getInviteEphemeralPubkeys()
}

// Subscribe to DM notifications
export async function subscribeToDMNotifications(): Promise<{ success: boolean; error?: string }> {
  try {
    // Check permission
    if (Notification.permission !== 'granted') {
      const result = await Notification.requestPermission()
      if (result !== 'granted') {
        return { success: false, error: 'Notification permission denied' }
      }
    }

    // Get push subscription
    const pushSubscription = await getOrCreatePushSubscription()
    if (!pushSubscription) {
      return { success: false, error: 'Failed to create push subscription' }
    }

    const currentIdentity = get(identity)
    if (!currentIdentity) {
      return { success: false, error: 'Not logged in' }
    }

    // Get session authors for DM notifications
    const sessionAuthors = getSessionAuthors()

    // Get invite recipients for invite response notifications
    const inviteRecipients = getInviteRecipients()

    if (sessionAuthors.length === 0 && inviteRecipients.length === 0) {
      // No active sessions or invites, but we can still enable notifications for future
      notificationSettings.setEnabled(true)
      return { success: true }
    }

    // Prepare web push data
    const webPushData: WebPushSubscription = {
      endpoint: pushSubscription.endpoint,
      p256dh: arrayBufferToBase64(pushSubscription.getKey('p256dh')!),
      auth: arrayBufferToBase64(pushSubscription.getKey('auth')!)
    }

    const settings = get(notificationSettings)
    const api = new NotificationService(settings.serverUrl)

    // Get current subscriptions
    const currentSubscriptions = await api.getNotificationSubscriptions()

    // Handle DM message subscription
    if (sessionAuthors.length > 0) {
      const messageFilter = {
        kinds: [MESSAGE_EVENT_KIND],
        authors: sessionAuthors
      }

      // Find existing subscription for DM messages
      const existingMessageSub = Object.entries(currentSubscriptions).find(
        ([, sub]) =>
          sub.filter.kinds?.length === 1 &&
          sub.filter.kinds[0] === MESSAGE_EVENT_KIND &&
          sub.filter.authors &&
          sub.web_push_subscriptions?.some(s => s.endpoint === webPushData.endpoint)
      )

      if (existingMessageSub) {
        const [id, sub] = existingMessageSub
        const existingAuthors = sub.filter.authors || []

        // Update if authors changed
        if (!arraysEqual(existingAuthors, sessionAuthors)) {
          await api.updateNotificationSubscription(id, {
            filter: messageFilter,
            web_push_subscriptions: [webPushData],
            webhooks: [],
            subscriber: sub.subscriber
          })
        }
      } else {
        // Create new subscription
        await api.registerPushNotifications([webPushData], messageFilter)
      }

      lastSyncedAuthors = sessionAuthors
    }

    // Handle invite response subscription
    if (inviteRecipients.length > 0) {
      const inviteFilter = {
        kinds: [INVITE_RESPONSE_KIND],
        '#p': inviteRecipients
      }

      // Find existing subscription for invite responses
      const existingInviteSub = Object.entries(currentSubscriptions).find(
        ([, sub]) =>
          sub.filter.kinds?.length === 1 &&
          sub.filter.kinds[0] === INVITE_RESPONSE_KIND &&
          sub.filter['#p'] &&
          sub.web_push_subscriptions?.some(s => s.endpoint === webPushData.endpoint)
      )

      if (existingInviteSub) {
        const [id, sub] = existingInviteSub
        const existingRecipients = sub.filter['#p'] || []

        // Update if recipients changed
        if (!arraysEqual(existingRecipients, inviteRecipients)) {
          await api.updateNotificationSubscription(id, {
            filter: inviteFilter,
            web_push_subscriptions: [webPushData],
            webhooks: [],
            subscriber: sub.subscriber
          })
        }
      } else {
        // Create new subscription
        await api.registerPushNotifications([webPushData], inviteFilter)
      }

      lastSyncedInviteRecipients = inviteRecipients
    } else {
      // Remove invite subscription if no more invites
      const existingInviteSub = Object.entries(currentSubscriptions).find(
        ([, sub]) =>
          sub.filter.kinds?.length === 1 &&
          sub.filter.kinds[0] === INVITE_RESPONSE_KIND &&
          sub.filter['#p'] &&
          sub.web_push_subscriptions?.some(s => s.endpoint === webPushData.endpoint)
      )

      if (existingInviteSub) {
        const [id] = existingInviteSub
        try {
          await api.deleteNotificationSubscription(id)
        } catch {
          // Ignore deletion errors
        }
      }
      lastSyncedInviteRecipients = []
    }

    notificationSettings.setEnabled(true)
    return { success: true }
  } catch (error) {
    console.error('Failed to subscribe to DM notifications:', error)
    return { success: false, error: String(error) }
  }
}

// Unsubscribe from DM notifications
export async function unsubscribeFromDMNotifications(): Promise<{ success: boolean; error?: string }> {
  try {
    if (!('serviceWorker' in navigator)) {
      notificationSettings.setEnabled(false)
      return { success: true }
    }

    const reg = await navigator.serviceWorker.ready
    const pushSubscription = await reg.pushManager.getSubscription()

    if (!pushSubscription) {
      notificationSettings.setEnabled(false)
      return { success: true }
    }

    const settings = get(notificationSettings)
    const api = new NotificationService(settings.serverUrl)

    try {
      // Get current subscriptions and delete matching ones
      const currentSubscriptions = await api.getNotificationSubscriptions()

      const deletePromises = Object.entries(currentSubscriptions)
        .filter(([, sub]) =>
          sub.web_push_subscriptions?.some(s => s.endpoint === pushSubscription.endpoint)
        )
        .map(([id]) => api.deleteNotificationSubscription(id))

      await Promise.all(deletePromises)
    } catch (err) {
      console.error('Failed to delete server subscriptions:', err)
      // Continue with local unsubscribe even if server fails
    }

    // Unsubscribe from push notifications at browser level
    await pushSubscription.unsubscribe()
    subscriptionPromise = null
    lastSyncedAuthors = []
    lastSyncedInviteRecipients = []

    notificationSettings.setEnabled(false)
    return { success: true }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// Helper to compare arrays
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((val, idx) => sortedB[idx] === val)
}

// Update subscription when sessions or invites change
export async function updateDMSubscription(): Promise<void> {
  const settings = get(notificationSettings)
  if (!settings.enabled) return

  // Check if authors have changed
  const currentAuthors = getSessionAuthors()
  const currentInviteRecipients = getInviteRecipients()

  const authorsChanged = !arraysEqual(currentAuthors, lastSyncedAuthors)
  const inviteRecipientsChanged = !arraysEqual(currentInviteRecipients, lastSyncedInviteRecipients)

  if (!authorsChanged && !inviteRecipientsChanged) return

  try {
    await subscribeToDMNotifications()
  } catch {
    // Ignore subscription errors
  }
}

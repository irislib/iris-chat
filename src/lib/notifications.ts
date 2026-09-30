// Notification utilities for iris-chat
import { get } from 'svelte/store'
import { identity, nostrClient } from './identity'
import { notificationSettings } from './notificationStore'
import { chatMutes, loadChatMutes } from './chatMuteStore'
import { mutedMessageFilters } from './chatMutePolicy'
import { getNotificationSupportError, requestNotificationPermission } from './notificationPermission'
import { getInviteEphemeralPubkeys } from './chat'
import { AppEvent } from './nostrClient'
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
    since?: number
    until?: number
    '#p'?: string[]
  }
  filters?: NotificationSubscription['filter'][]
  subscriber: string
}

export interface NotificationSubscriptionResponse {
  [key: string]: NotificationSubscription
}

export class NotificationService {
  private baseUrl: string
  private readonly owner = get(identity)?.pubkey

  constructor(baseUrl?: string) {
    const settings = get(notificationSettings)
    // Ensure URL ends with /
    let url = baseUrl || settings.serverUrl
    if (!url.endsWith('/')) {
      url += '/'
    }
    this.baseUrl = url
  }

  async getInfo(): Promise<{ vapid_public_key: string; supports_timed_filters?: boolean }> {
    return this.getJson('info')
  }

  async getNotificationSubscriptions(): Promise<NotificationSubscriptionResponse> {
    return this.getJsonAuthd('subscriptions/')
  }

  async registerPushNotifications(
    web_push_subscriptions: WebPushSubscription[],
    filter: NotificationSubscription['filter'],
    filters?: NotificationSubscription['filter'][]
  ): Promise<{ id: string; status: string }> {
    return this.getJsonAuthd('subscriptions', 'POST', {
      web_push_subscriptions,
      webhooks: [],
      filter, ...(filters ? { filters } : {})
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
    const client = get(nostrClient)

    if (!currentIdentity || !client.signer || currentIdentity.pubkey !== this.owner) {
      throw new Error('Not logged in')
    }

    const url = `${this.baseUrl}${path}`

    const event = new AppEvent(client)
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
    if (get(identity)?.pubkey !== this.owner) throw new Error('Profile changed')

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
let lastSyncedMessageInput = ''
let lastSyncedInviteRecipients: string[] = []

// Get or create push subscription
export async function getOrCreatePushSubscription(): Promise<PushSubscription | null> {
  if (getNotificationSupportError()) {
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
function getSessionAuthorsByChat(): Map<string, string[]> {
  const currentIdentity = get(identity)
  if (!currentIdentity) return new Map()

  const byChat = new Map<string, string[]>()

  const userRecords = getNdrRuntime().getSessionUserRecords()
  for (const [userPubkey, record] of userRecords.entries()) {
    // Skip self-sessions (our own devices) to avoid notifications for our own messages
    if (userPubkey === currentIdentity.pubkey) continue
    const authors: string[] = []
    for (const device of record.devices?.values() ?? []) {
      const sessions = [
        ...(device.activeSession ? [device.activeSession] : []),
        ...(device.inactiveSessions ?? []),
      ]
      for (const session of sessions) {
        const state = session?.state
        if (!state) continue
        if ('skippedKeys' in state && state.skippedKeys && typeof state.skippedKeys === 'object')
          authors.push(...Object.keys(state.skippedKeys))
        if (state.theirCurrentNostrPublicKey) {
          authors.push(state.theirCurrentNostrPublicKey)
        }
        if (state.theirNextNostrPublicKey) {
          authors.push(state.theirNextNostrPublicKey)
        }
      }
    }
    byChat.set(userPubkey, [...new Set(authors)].sort())
  }

  return byChat
}

// Get invite ephemeral pubkeys for notification subscription
function getInviteRecipients(): string[] {
  return getInviteEphemeralPubkeys()
}

// Subscribe to DM notifications
type SubscriptionResult = { success: boolean; error?: string }
let syncQueue: Promise<unknown> = Promise.resolve()
export async function subscribeToDMNotifications(): Promise<SubscriptionResult> {
  // Keep the native permission request in the initiating user gesture.
  const permission = await requestNotificationPermission()
  if (permission.error) return { success: false, error: permission.error }
  // Serialize writes; each run reads the latest profile and mute deadlines.
  const sync = syncQueue.then(syncDMNotifications, syncDMNotifications)
  syncQueue = sync.catch(() => {})
  return sync
}

async function syncDMNotifications(): Promise<SubscriptionResult> {
  try {
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
    await loadChatMutes(currentIdentity.pubkey)
    if (get(identity)?.pubkey !== currentIdentity.pubkey) return { success: false, error: 'Profile changed' }
    const mutes = get(chatMutes)
    const authorsByChat = getSessionAuthorsByChat()
    const desiredFilters = mutedMessageFilters(authorsByChat, mutes, MESSAGE_EVENT_KIND, true)
    const messageInput = currentIdentity.pubkey + ':' + JSON.stringify(desiredFilters)

    // Get invite recipients for invite response notifications
    const inviteRecipients = getInviteRecipients()

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

    // Time bounds must be supported by the server: workers cannot reliably hide
    // every userVisibleOnly push. Old servers conservatively exclude muted authors.
    const needsTimed = desiredFilters.some(filter => filter.since !== undefined)
    const supportsTimed = !needsTimed || await api.getInfo().then(info => info.supports_timed_filters === true).catch(() => false)
    const filters = mutedMessageFilters(authorsByChat, mutes, MESSAGE_EVENT_KIND, supportsTimed)
    if (get(identity)?.pubkey !== currentIdentity.pubkey) return { success: false, error: 'Profile changed' }
    const existingMessageSub = Object.entries(currentSubscriptions).find(([, sub]) =>
      sub.filter.kinds?.length === 1 && sub.filter.kinds[0] === MESSAGE_EVENT_KIND && sub.filter.authors &&
      sub.web_push_subscriptions?.some(item => item.endpoint === webPushData.endpoint))
    if (existingMessageSub) {
      const [id, sub] = existingMessageSub
      if (!sameMessageFilters([sub.filter], [filters[0]]) || !sameMessageFilters(sub.filters ?? [sub.filter], filters)) {
        await api.updateNotificationSubscription(id, {
          filter: filters[0], filters, web_push_subscriptions: [webPushData], webhooks: [], subscriber: sub.subscriber,
        })
      }
    } else if (filters.some(filter => filter.authors.length)) {
      await api.registerPushNotifications([webPushData], filters[0], filters)
    }
    if (get(identity)?.pubkey !== currentIdentity.pubkey) return { success: false, error: 'Profile changed' }
    lastSyncedMessageInput = messageInput

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

    if (get(identity)?.pubkey !== currentIdentity.pubkey) return { success: false, error: 'Profile changed' }
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
    lastSyncedMessageInput = ''
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

function sameMessageFilters(a: NotificationSubscription['filter'][], b: NotificationSubscription['filter'][]): boolean {
  const canonical = (filters: NotificationSubscription['filter'][]) => JSON.stringify(filters.map(filter => ({
    kinds: filter.kinds ?? [], authors: [...(filter.authors ?? [])].sort(), since: filter.since ?? null,
  })))
  return canonical(a) === canonical(b)
}

// Update subscription when sessions, mutes or invites change. Never prompt from a timer.
export async function updateDMSubscription(): Promise<void> {
  if (!get(notificationSettings).enabled || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const account = get(identity)?.pubkey
  if (!account) return
  await loadChatMutes(account)
  if (get(identity)?.pubkey !== account) return
  let currentMessageInput: string
  try { currentMessageInput = account + ':' + JSON.stringify(mutedMessageFilters(getSessionAuthorsByChat(), get(chatMutes), MESSAGE_EVENT_KIND, true)) }
  catch { return } // The messaging runtime may still be restoring.
  const recipients = getInviteRecipients()
  if (currentMessageInput === lastSyncedMessageInput && arraysEqual(recipients, lastSyncedInviteRecipients)) return
  await subscribeToDMNotifications()
}

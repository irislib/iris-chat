/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching'
import { Session, type Rumor, type NostrSubscribe, deserializeSessionState, MESSAGE_EVENT_KIND, INVITE_RESPONSE_KIND } from 'nostr-double-ratchet'
import Dexie, { type Table } from 'dexie'
import { getAnimalName } from './lib/animalNames'
import { generateProxyUrl } from './lib/imgproxy'
import { shouldShowInviteResponseNotification, shouldShowSystemNotificationForMessagePush } from './lib/swNotificationPolicy'

declare let self: ServiceWorkerGlobalScope

type NostrEvent = Parameters<Parameters<NostrSubscribe>[1]>[0]

// Precache assets
precacheAndRoute(self.__WB_MANIFEST)

// Dexie DB for service worker (must match main app schema)
interface StoredSession {
  id: string
  recipientPubkey: string
  sessionState?: string
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

interface SessionManagerRecord {
  key: string
  value: unknown
}

interface SessionManagerStateEntry {
  stateJson: string
  chatId?: string
}

interface StoredSessionEntry {
  name: string
  state: string
}

interface StoredDeviceRecord {
  deviceId: string
  activeSession: StoredSessionEntry | null
  inactiveSessions: StoredSessionEntry[]
  createdAt: number
}

interface StoredUserRecord {
  publicKey: string
  devices: StoredDeviceRecord[]
  knownDeviceIdentities?: string[]
}

class IrisChatDB extends Dexie {
  sessions!: Table<StoredSession, string>
  messages!: Table<StoredMessage, string>
  profiles!: Table<StoredProfile, string>
  invites!: Table<StoredInvite, string>
  processedEvents!: Table<ProcessedEvent, string>
  sessionManager!: Table<SessionManagerRecord, string>

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
    this.version(4).stores({
      sessions: 'id',
      messages: 'id, sessionId',
      profiles: 'pubkey',
      invites: 'id',
      processedEvents: 'id, timestamp',
      groups: 'id'
    })
    this.version(5).stores({
      sessions: 'id',
      messages: 'id, sessionId',
      profiles: 'pubkey',
      invites: 'id',
      processedEvents: 'id, timestamp',
      groups: 'id',
      sessionManager: 'key'
    })
  }
}

const db = new IrisChatDB()
const appLogoUrl = new URL('iris-logo.png', self.registration.scope).toString()

// Track currently open chat (only one can be open at a time)
let currentOpenChatId: string | null = null

async function getOwnerPubkeyFromSessionManager(): Promise<string | null> {
  try {
    const record = await db.sessionManager.get('v1/device-manager/owner-pubkey')
    if (record?.value && typeof record.value === 'string') {
      return record.value
    }
  } catch {
    // ignore
  }
  return null
}

function parseSessionManagerUserKey(key: string): string | null {
  const prefix = 'v1/user/'
  if (!key.startsWith(prefix)) return null
  const rest = key.slice(prefix.length)
  const slashIndex = rest.indexOf('/')
  const candidate = (slashIndex >= 0 ? rest.slice(0, slashIndex) : rest).trim()
  if (!/^[0-9a-f]{64}$/i.test(candidate)) return null
  return candidate.toLowerCase()
}

async function getSessionManagerStates(): Promise<SessionManagerStateEntry[]> {
  const states: SessionManagerStateEntry[] = []
  try {
    const records = await db.sessionManager
      .filter((record) => record.key.startsWith('v1/user/'))
      .toArray()
    for (const record of records) {
      const chatId = parseSessionManagerUserKey(record.key) || undefined
      const data = record.value as StoredUserRecord | undefined
      if (!data?.devices) continue
      for (const device of data.devices) {
        if (device.activeSession?.state) {
          states.push({ stateJson: device.activeSession.state, chatId })
        }
        for (const inactive of device.inactiveSessions || []) {
          if (inactive.state) states.push({ stateJson: inactive.state, chatId })
        }
      }
    }
  } catch (err) {
    console.error('[sw] error reading SessionManager states:', err)
  }
  return states
}

// Get display info from profile
async function getSenderInfo(pubkey: string): Promise<{ name: string; icon: string }> {
  const fallbackIcon = appLogoUrl
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
  // Check if main app already processed this event (outer id)
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

  const ownerPubkey = await getOwnerPubkeyFromSessionManager()

  const sessionEntries: Array<{ chatId?: string; stateJson: string }> = []
  const sessions = await db.sessions.toArray()
  for (const storedSession of sessions) {
    if (storedSession.sessionState) {
      sessionEntries.push({ chatId: storedSession.recipientPubkey, stateJson: storedSession.sessionState })
    }
  }

  const managerStates = await getSessionManagerStates()
  for (const stateEntry of managerStates) {
    sessionEntries.push(stateEntry)
  }

  for (const entry of sessionEntries) {
    try {
      const state = deserializeSessionState(entry.stateJson)

      // Check if this message is from this session's peer
      const skippedAuthors = Object.keys(state.skippedKeys || {})
      if (state.theirCurrentNostrPublicKey !== eventData.pubkey &&
          state.theirNextNostrPublicKey !== eventData.pubkey &&
          !skippedAuthors.includes(eventData.pubkey)) {
        continue
      }

      // Fast path: check if main app already decrypted and saved this message
      const outerId = eventData.id
      if (entry.chatId && outerId) {
        const storedMessage = await db.messages.get(outerId)
        if (storedMessage && !storedMessage.isMine) {
          return {
            success: true,
            content: storedMessage.content,
            chatId: entry.chatId,
          }
        }
      }

      // Slow path: try to decrypt using Session class
      const eventForSession: NostrEvent = {
        ...eventData as unknown as NostrEvent,
        tags: eventData.tags.filter(([key]) => key === 'header'),
      }

      const session = new Session(state)
      const innerEvent = session.receiveEvent(eventForSession) || null

      if (innerEvent) {
        const innerId = innerEvent.id
        const processedInner = await db.processedEvents.get(innerId)
        if (processedInner) {
          if (processedInner.kind === KIND_TYPING || processedInner.kind === KIND_RECEIPT) {
            return { success: true, chatId: processedInner.chatId, silent: true }
          }
          if (processedInner.kind === KIND_REACTION) {
            return {
              success: true,
              content: `Reacted ${processedInner.content || ''}`,
              chatId: processedInner.chatId,
            }
          }
        }

        const storedInnerMessage = await db.messages.get(innerId)
        if (storedInnerMessage && !storedInnerMessage.isMine) {
          return {
            success: true,
            content: storedInnerMessage.content,
            chatId: entry.chatId || storedInnerMessage.sessionId,
          }
        }

        const pTag = innerEvent.tags?.find((t) => t[0] === 'p')?.[1]
        let chatId = entry.chatId
        if (!chatId) {
          if (ownerPubkey && innerEvent.pubkey === ownerPubkey && pTag) {
            chatId = pTag
          } else {
            chatId = innerEvent.pubkey || pTag
          }
        }

        // Suppress notifications for typing, receipts, and our own messages from other devices
        const isSelfMessage = ownerPubkey != null && innerEvent.pubkey === ownerPubkey
        const silent = innerEvent.kind === KIND_RECEIPT || innerEvent.kind === KIND_TYPING || isSelfMessage
        return {
          success: true,
          content: innerEvent.kind === KIND_REACTION
            ? `Reacted ${innerEvent.content}`
            : innerEvent.content,
          chatId,
          silent,
        }
      }
    } catch (err) {
      console.error('[sw] decrypt error:', err)
    }
  }

  return { success: false }
}

type VisibleClientState = {
  anyVisible: boolean
  openChatId: string | null
}

// Find visible clients and ask them which chat is currently open.
async function getVisibleClientState(): Promise<VisibleClientState> {
  // includeUncontrolled ensures we still detect already-open tabs/windows
  // after an SW restart/update before the page is fully controlled.
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })

  // Find visible clients
  const visibleClients = clients.filter(c => c.visibilityState === 'visible')
  
  if (visibleClients.length === 0) {
    currentOpenChatId = null
    console.log('[sw] isChatOpen: no visible clients')
    return { anyVisible: false, openChatId: null }
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

  return { anyVisible: true, openChatId: currentOpenChatId }
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

        const visible = await getVisibleClientState()
        if (!shouldShowInviteResponseNotification({ anyVisibleClient: visible.anyVisible })) {
          console.log('[sw] suppressing invite response notification because app is visible')
          return
        }

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
          icon: appLogoUrl,
          badge: appLogoUrl,
          tag: 'invite-response'
        })
        return
      }

      // Handle regular message notifications
      if (eventKind === MESSAGE_EVENT_KIND) {
        const result = await decryptPushMessage(payload.event)

        if (result.chatId) {
          // Suppress notifications when iris-chat is already visible or the inner
          // event is non-user-facing (typing/receipts/etc.). Brave can surface
          // "silent" placeholder notifications, so we avoid them entirely.
          if (result.silent) {
            return
          }
          const visible = await getVisibleClientState()
          if (!shouldShowSystemNotificationForMessagePush({
            anyVisibleClient: visible.anyVisible,
            silentEvent: false,
          })) {
            console.log('[sw] suppressing notification', {
              chatId: result.chatId,
              openChatId: visible.openChatId,
            })
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
            badge: appLogoUrl,
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
    icon: appLogoUrl,
    badge: appLogoUrl
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

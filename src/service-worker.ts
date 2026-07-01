/// <reference lib="webworker" />
import {
  Session,
  type Rumor,
  type NostrSubscribe,
  deserializeSessionState,
  MESSAGE_EVENT_KIND,
  INVITE_RESPONSE_KIND,
  CHAT_MESSAGE_KIND,
} from 'nostr-double-ratchet'
import { renderRumor } from './lib/pushRumorRender'
import {
  extractPushNostrEvent,
  PUSH_NOSTR_EVENT_MESSAGE,
} from './lib/pushEvents'
import Dexie, { type Table } from 'dexie'
import { getAnimalName } from './lib/animalNames'
import { generateProxyUrl } from './lib/imgproxy'

// Avoid importing from profilePicture.ts here so the service worker doesn't pull in @hashtree/core.
function isHashtreePicture(picture: string | undefined): boolean {
  return !!picture && (picture.startsWith('htree://') || picture.startsWith('nhash://'))
}

declare let self: ServiceWorkerGlobalScope

type NostrEvent = Parameters<Parameters<NostrSubscribe>[1]>[0]

// Keep this worker focused on push notifications. App-shell caching and
// client-claiming can interrupt active invite joins during service-worker
// updates, while the chat runtime already works from the network/cache layer
// provided by the browser and CDN.

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
  isSelfMessage?: boolean
  timestamp: number
}

interface PendingPushEvent {
  id: string
  event: NostrEvent
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
  pendingPushEvents!: Table<PendingPushEvent, string>

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
    this.version(6).stores({
      sessions: 'id',
      messages: 'id, sessionId',
      profiles: 'pubkey',
      invites: 'id',
      processedEvents: 'id, timestamp',
      groups: 'id',
      sessionManager: 'key',
      pendingPushEvents: 'id, timestamp'
    })
  }
}

const db = new IrisChatDB()
const appLogoUrl = new URL('iris-logo.png', self.registration.scope).toString()
const PENDING_PUSH_EVENT_MAX_AGE_MS = 24 * 60 * 60 * 1000
const MAX_PENDING_PUSH_EVENTS = 64

// Track currently open chat (only one can be open at a time)
let currentOpenChatId: string | null = null

async function savePendingPushEvent(event: NostrEvent): Promise<void> {
  if (!event.id) return
  const now = Date.now()
  await db.pendingPushEvents.put({ id: event.id, event, timestamp: now })
  await db.pendingPushEvents
    .where('timestamp')
    .below(now - PENDING_PUSH_EVENT_MAX_AGE_MS)
    .delete()

  const count = await db.pendingPushEvents.count()
  if (count <= MAX_PENDING_PUSH_EVENTS) return

  const stale = await db.pendingPushEvents
    .orderBy('timestamp')
    .limit(count - MAX_PENDING_PUSH_EVENTS)
    .toArray()
  await db.pendingPushEvents.bulkDelete(stale.map((record) => record.id))
}

async function forwardPushEventToClients(event: NostrEvent): Promise<void> {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const client of clients) {
    client.postMessage({ type: PUSH_NOSTR_EVENT_MESSAGE, event })
  }
}

async function capturePushNostrEvent(payload: unknown): Promise<void> {
  const nostrEvent = extractPushNostrEvent(payload)
  if (!nostrEvent) return
  await savePendingPushEvent(nostrEvent as unknown as NostrEvent)
  await forwardPushEventToClients(nostrEvent as unknown as NostrEvent)
}

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
      // htree:// pictures require hashtree decryption which isn't wired into the SW; fall back to the app icon.
      const icon = profile.picture && !isHashtreePicture(profile.picture)
        ? await generateProxyUrl(profile.picture, { width: 96, height: 96, square: true })
        : fallbackIcon
      return { name, icon }
    }
  } catch (err) {
    console.error('[sw] error fetching profile:', err)
  }
  return { name: getAnimalName(pubkey), icon: fallbackIcon }
}

// Web push cannot be suppressed server-side, so the SW must decrypt and
// classify every incoming inner-rumor kind, then render an appropriate
// notification. Suppressing showNotification when the app isn't engaged
// would leave Chrome to surface a generic "site updated in the background"
// placeholder; the user prefers to see what was actually received.

interface DecryptResult {
  success: boolean
  chatId?: string
  // Inner rumor kind, when known. Drives notification rendering.
  kind?: number
  // Inner rumor content (raw), when known. Empty/undefined for kinds that
  // carry no payload (typing).
  content?: string
  // True when the rumor was authored by our own pubkey on another device.
  // Suppressed from notifications (already happened on the other device).
  isSelfMessage?: boolean
}

// Find session and decrypt message
async function decryptPushMessage(eventData: { id?: string; pubkey: string; tags: string[][]; [key: string]: unknown }): Promise<DecryptResult> {
  // Check if main app already processed this event (outer id)
  if (eventData.id) {
    try {
      const processed = await db.processedEvents.get(eventData.id)
      if (processed) {
        return {
          success: true,
          chatId: processed.chatId,
          kind: processed.kind,
          content: processed.content,
          isSelfMessage: processed.isSelfMessage,
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
        if (storedMessage) {
          return {
            success: true,
            chatId: entry.chatId,
            kind: CHAT_MESSAGE_KIND,
            content: storedMessage.content,
            isSelfMessage: storedMessage.isMine,
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
        const isSelfMessage = ownerPubkey != null && innerEvent.pubkey === ownerPubkey

        const processedInner = await db.processedEvents.get(innerId)
        if (processedInner) {
          return {
            success: true,
            chatId: processedInner.chatId,
            kind: processedInner.kind,
            content: processedInner.content ?? innerEvent.content,
            isSelfMessage,
          }
        }

        const storedInnerMessage = await db.messages.get(innerId)
        if (storedInnerMessage) {
          return {
            success: true,
            chatId: entry.chatId || storedInnerMessage.sessionId,
            kind: CHAT_MESSAGE_KIND,
            content: storedInnerMessage.content,
            isSelfMessage: storedInnerMessage.isMine || isSelfMessage,
          }
        }

        const pTag = innerEvent.tags?.find((t) => t[0] === 'p')?.[1]
        let chatId = entry.chatId
        if (!chatId) {
          if (isSelfMessage && pTag) {
            chatId = pTag
          } else {
            chatId = innerEvent.pubkey || pTag
          }
        }

        return {
          success: true,
          chatId,
          kind: innerEvent.kind,
          content: innerEvent.content,
          isSelfMessage,
        }
      }
    } catch (err) {
      console.error('[sw] decrypt error:', err)
    }
  }

  return { success: false }
}

type EngagementState = {
  anyVisible: boolean
  // True iff at least one client has the document focused (i.e. window is the
  // top app and the tab is foregrounded). A visibilityState of 'visible' is
  // not enough — a tab can be visible but the window can be behind another.
  focused: boolean
  // chatId of the currently-open chat in any visible client. If multiple
  // clients are visible, the most recently observed wins.
  openChatId: string | null
}

// Ask clients about visibility, focus, and which chat they currently have open.
async function getEngagementState(): Promise<EngagementState> {
  // includeUncontrolled ensures we still detect already-open tabs/windows
  // after an SW restart/update before the page is fully controlled.
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })

  const visibleClients = clients.filter(c => c.visibilityState === 'visible')

  if (visibleClients.length === 0) {
    currentOpenChatId = null
    return { anyVisible: false, focused: false, openChatId: null }
  }

  const focused = visibleClients.some(c => c.focused)

  // Ask visible clients what chat is currently open. This handles the case
  // where the SW was restarted and lost its in-memory currentOpenChatId.
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

  return { anyVisible: true, focused, openChatId: currentOpenChatId }
}

// Handle push notifications
self.addEventListener('push', (event) => {
  if (!event.data) return

  const handlePush = async () => {
    try {
      const payload = event.data?.json()
      await capturePushNostrEvent(payload)
      if (!payload?.event) {
        await showFallbackNotification()
        return
      }

      const eventKind = payload.event.kind

      // Handle invite response notifications
      if (eventKind === INVITE_RESPONSE_KIND) {
        const engagement = await getEngagementState()
        if (engagement.focused) {
          // User is actively in iris-chat — UA considers them engaged, the
          // in-app UI will surface the new chat, and silent push is allowed.
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
        const engagement = await getEngagementState()

        if (!result.success || !result.chatId) {
          // Couldn't identify a session for this push. If a client is
          // visible the main app's relay subscription will catch up.
          // Otherwise fall back to a generic notification so the user knows
          // something happened.
          if (engagement.anyVisible) return
          await showFallbackNotification()
          return
        }

        // User is already looking at this exact conversation — silent push
        // allowed by spec, in-app UI shows the update.
        if (engagement.focused && engagement.openChatId === result.chatId) {
          return
        }

        // Our own rumor sent from another device — already actioned there.
        if (result.isSelfMessage) {
          return
        }

        const rendered = renderRumor(result.kind, result.content)
        if (!rendered) {
          // Internal/cryptographic rumor with no user-facing description.
          // Skip rather than show garbage; the main app handles it on its
          // own subscription.
          return
        }

        const sender = await getSenderInfo(result.chatId)
        const tag = rendered.durable ? `dm-${result.chatId}` : `dm-${result.chatId}-status`
        await self.registration.showNotification(sender.name, {
          body: rendered.body,
          icon: sender.icon,
          badge: appLogoUrl,
          tag,
          silent: !rendered.durable,
          data: { chatId: result.chatId }
        })
        return
      }

      // Unknown outer event kind — let the main app catch up via its
      // subscription, skip the notification.
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

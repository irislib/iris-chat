/// <reference lib="webworker" />
import { messageNotificationAllowed } from './lib/messageNotificationPolicy'
import { decryptGroupPush } from './lib/groupPush'
import { showUnreadNotification } from './lib/readNotifications'
import { applyAuthenticatedOwnRead } from './lib/ownReadState'
import { AppKeys } from 'nostr-double-ratchet'
import { mentionSetting, mentionSettingKey, shouldNotifyMutedMessage } from './lib/mentionNotificationPolicy'
import type { PrivateEvent } from 'nostr-social-graph/privateEvents'
import { readState } from './lib/privateStateStore'
import {
  Session,
  type Rumor,
  type NostrSubscribe,
  deserializeSessionState,
  MESSAGE_EVENT_KIND,
  INVITE_RESPONSE_KIND,
  CHAT_MESSAGE_KIND,
  getExpirationTimestampSeconds,
} from 'nostr-double-ratchet'
import { chatMutesKey, normalizeChatMutes } from './lib/chatMutePolicy'
import { renderRumor } from './lib/pushRumorRender'
import {
  extractPushNostrEvent,
  PUSH_NOSTR_EVENT_MESSAGE,
} from './lib/pushEvents'
import Dexie, { type Table } from 'dexie'
import { getAnimalName } from './lib/animalNames'
import { generateProxyUrl } from './lib/imgproxy'
import { notificationHash, notificationTarget, type NotificationTarget } from './lib/notificationNavigation'

// Avoid importing from profilePicture.ts here so the service worker doesn't pull in @hashtree/core.
function isHashtreePicture(picture: string | undefined): boolean {
  return !!picture && (picture.startsWith('htree://') || picture.startsWith('nhash://'))
}

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision?: string | null }> }

type NostrEvent = Parameters<Parameters<NostrSubscribe>[1]>[0]

// Updates wait for open chats to close; cached assets also include the event worker.
import { installOfflineShell } from './lib/offlineShell'
installOfflineShell(self, self.__WB_MANIFEST ?? [])

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
  senderPubkey?: string
  status?: 'delivered' | 'seen'
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
  messageId?: string
  author?: string
  createdAtSecs?: number
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
  deviceId?: string
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
  appKeys?: string
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
          states.push({ stateJson: device.activeSession.state, chatId, deviceId:device.deviceId })
        }
        for (const inactive of device.inactiveSessions || []) {
          if (inactive.state) states.push({ stateJson: inactive.state, chatId, deviceId:device.deviceId })
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
    if (pubkey.startsWith('group:')) {
      const group = await db.table('groups').get(pubkey.slice(6))
      if (group) return {name:group.name,icon:fallbackIcon}
    }
    const owner = await getOwnerPubkeyFromSessionManager()
    const memory = owner ? (await db.sessionManager.get(`iris-contact-memory:v1:${owner}:${pubkey}`))?.value as { accepted_name?: unknown; nickname?: unknown } | undefined : undefined
    const acceptedName = typeof memory?.nickname === 'string' && memory.nickname ? memory.nickname : typeof memory?.accepted_name === 'string' ? memory.accepted_name : undefined
    const profile = await db.profiles.get(pubkey)
    if (profile) {
      const name = acceptedName || profile.display_name || profile.name || getAnimalName(pubkey)
      // htree:// pictures require hashtree decryption which isn't wired into the SW; fall back to the app icon.
      const icon = profile.picture && !isHashtreePicture(profile.picture)
        ? await generateProxyUrl(profile.picture, { width: 96, height: 96, square: true })
        : fallbackIcon
      return { name, icon }
    }
    if (acceptedName) return { name: acceptedName, icon: fallbackIcon }
  } catch (err) {
    console.error('[sw] error fetching profile:', err)
  }
  return { name: getAnimalName(pubkey), icon: fallbackIcon }
}

// Server filters silence muted chats before a userVisibleOnly push is sent.
// This worker also checks saved deadlines for already in-flight pushes and
// classifies the remaining decrypted rumors before displaying them.

interface DecryptResult {
  expiresAt?: number;
  messageId?: string
  author?: string
  createdAtSecs?: number
  seen?: boolean
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
          isSelfMessage: processed.isSelfMessage, messageId: processed.messageId, author: processed.author, createdAtSecs: processed.createdAtSecs,
        }
      }
    } catch (err) {
      console.error('[sw] error checking processedEvents:', err)
    }
  }

  const ownerPubkey = await getOwnerPubkeyFromSessionManager()

  if (ownerPubkey) {
    const group = await decryptGroupPush(ownerPubkey,eventData as unknown as NostrEvent)
    if (group) return group
  }

  const sessionEntries: SessionManagerStateEntry[] = []
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
            isSelfMessage: storedMessage.isMine, messageId: storedMessage.id, author: storedMessage.senderPubkey ?? entry.chatId, createdAtSecs: Math.floor(storedMessage.timestamp / 1000), seen: storedMessage.status === 'seen',
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
        const ownSession = !!ownerPubkey && entry.chatId === ownerPubkey
        const isSelfMessage = ownSession || ownerPubkey != null && innerEvent.pubkey === ownerPubkey
        if (ownSession && innerEvent.kind === 15) {
          const record = (await db.sessionManager.get(`v1/user/${ownerPubkey}`))?.value as StoredUserRecord | undefined
          const roster = record?.appKeys ? AppKeys.deserialize(record.appKeys) : undefined
          if (entry.deviceId && roster?.getDevice(entry.deviceId) &&
            (innerEvent.pubkey === ownerPubkey || innerEvent.pubkey === entry.deviceId) && await getOwnerPubkeyFromSessionManager() === ownerPubkey) {
            const groupId = innerEvent.tags.find(tag => tag[0] === 'l')?.[1]
            const target = groupId ? `group:${groupId}` : innerEvent.tags.find(tag => tag[0] === 'p')?.[1]
            if (target) await applyAuthenticatedOwnRead(ownerPubkey,target,innerEvent,() => true)
          }
          return {success:true,chatId:ownerPubkey,isSelfMessage:true}
        }

        const processedInner = await db.processedEvents.get(innerId)
        if (processedInner) {
          return {
            success: true,
            chatId: processedInner.chatId,
            kind: processedInner.kind,
            content: processedInner.content ?? innerEvent.content,
            isSelfMessage, messageId: innerId, author: entry.chatId ?? innerEvent.pubkey, createdAtSecs: innerEvent.created_at,
          }
        }

        const storedInnerMessage = await db.messages.get(innerId)
        if (storedInnerMessage) {
          return {
            success: true,
            chatId: entry.chatId || storedInnerMessage.sessionId,
            kind: CHAT_MESSAGE_KIND,
            content: storedInnerMessage.content,
            isSelfMessage: storedInnerMessage.isMine || isSelfMessage, messageId: innerId, author: storedInnerMessage.senderPubkey ?? entry.chatId, createdAtSecs: innerEvent.created_at, seen: storedInnerMessage.status === 'seen',
          }
        }

        const pTag = innerEvent.tags?.find((t) => t[0] === 'p')?.[1]
        const groupId = innerEvent.tags.find(tag => tag[0] === 'l')?.[1]
        let chatId = groupId ? `group:${groupId}` : entry.chatId
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
          content: innerEvent.content, expiresAt: getExpirationTimestampSeconds(innerEvent),
          isSelfMessage, messageId: innerId, author: entry.chatId ?? innerEvent.pubkey, createdAtSecs: innerEvent.created_at,
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
          // in-app UI surfaces the new chat; browsers may still show a fallback.
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
          if (engagement.anyVisible) return
          // Unknown ciphertext may be a muted group message or own-device control.
          // Keep it queued. A userVisibleOnly browser can still generate its own
          // fallback alert; this is why silent-only channels are not subscribed.
          return
        }

        const owner = await getOwnerPubkeyFromSessionManager()
        if (result.seen) return
        if (owner) {
          if (!await messageNotificationAllowed(owner,{...result,chatId:result.chatId})) return
          if (result.messageId && result.createdAtSecs !== undefined && (await readState(owner, result.chatId, result.messageId))?.createdAtSecs === result.createdAtSecs) return
          const record = await db.sessionManager.get(chatMutesKey(owner))
          const setting = (await db.sessionManager.get(mentionSettingKey(owner,result.chatId)))?.value as PrivateEvent | undefined
          const enabled = setting ? mentionSetting(setting,owner).enabled : true
          if (!shouldNotifyMutedMessage(normalizeChatMutes(record?.value), result.chatId, result.content ?? '', owner, enabled, result.kind)) return
        }

        // The open app presents this update. Browser fallback behavior still varies.
        const openChatId = result.chatId.startsWith('group:') ? result.chatId.slice(6) : result.chatId
        if (engagement.focused && engagement.openChatId === openChatId) {
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
        const options: NotificationOptions = {
          body: rendered.body,
          icon: sender.icon,
          badge: appLogoUrl,
          tag,
          silent: !rendered.durable,
          data: { chatId: result.chatId, ownerPubkey: owner ?? undefined }
        }
        if (owner && result.messageId && result.createdAtSecs !== undefined) await showUnreadNotification(self.registration,
          {ownerPubkey:owner,chatId:result.chatId,messageId:result.messageId,createdAtSecs:result.createdAtSecs},sender.name,options)
        else await self.registration.showNotification(sender.name,options)
        return
      }

      // Unknown outer event kind — let the main app catch up via its
      // subscription, skip the notification.
    } catch (error) {
      console.error('[sw] push error:', error)
      // Leave undeciphered events queued. userVisibleOnly browsers may show
      // their own fallback alert even when the app does not display one.
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

// Keep a running call intact: route through the live app when it acknowledges
// the tap, falling back to a durable URL only if no app listener is ready.
async function deliverNotificationTarget(client: WindowClient, target: NotificationTarget): Promise<boolean> {
  return new Promise(resolve => {
    const channel = new MessageChannel()
    const finish = (received: boolean) => {
      clearTimeout(timeout)
      channel.port1.close()
      channel.port2.close()
      resolve(received)
    }
    const timeout = setTimeout(() => finish(false), 1500)
    channel.port1.onmessage = event => finish(event.data?.received === true)
    try { client.postMessage({ type: 'NOTIFICATION_CLICK', target }, [channel.port2]) }
    catch { finish(false) }
  })
}

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil((async () => {
    const target = notificationTarget(event.notification.data)
    const url = new URL(target ? notificationHash(target) : '/', self.location.origin + '/')
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of clients) {
      if (new URL(client.url).origin !== self.location.origin) continue
      try {
        const focused = await client.focus()
        if (target && !await deliverNotificationTarget(focused, target)) await focused.navigate(url.href)
        return
      } catch { /* Try another window, or open one if this window closed. */ }
    }
    await self.clients.openWindow(url.href)
  })())
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
      .then(notifications => notifications.filter(n => n.tag === tag || notificationTarget(n.data)?.chatId === event.data.chatId).forEach(n => n.close()))
  }
})

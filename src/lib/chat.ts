import { writable, get } from 'svelte/store'
import {
  Invite,
  type OnEventMeta,
  type Rumor,
  resolveSessionPubkeyToOwner as resolveSessionPubkeyToOwnerFromRecords,
  type SessionUserRecordsLike,
  REACTION_KIND,
  RECEIPT_KIND,
  CHAT_MESSAGE_KIND,
  CHAT_SETTINGS_KIND,
  buildReactionRumor,
  buildReceiptRumor,
  buildTextRumor,
  buildTypingRumor,
  ensureRecipientTag,
  parseReaction,
  isTyping,
  getExpirationTimestampSeconds,
} from 'nostr-double-ratchet'
export type { Invite } from 'nostr-double-ratchet'
import { nip19 } from 'nostr-tools'
import { getPubkey, hasNip44Support, isNip07Login } from './identity'
import { devices } from './devices'
import {
  ensureDeviceRegistered,
  getNdrRuntime,
  preparePeerNdrRuntime,
  republishInvite,
  waitForNdrRuntime,
  waitForSendReadyRuntime,
} from './privateChats'
import {
  saveSession as saveSessionToDb,
  getAllSessions,
  saveMessage as saveMessageToDb,
  getMessagesForSession,
  clearAllData,
  deleteSession as deleteSessionFromDb,
  deleteMessagesForSession,
  deleteMessage as deleteMessageFromDb,
  saveInvite as saveInviteToDb,
  getAllInvites,
  deleteInvite as deleteInviteFromDb,
  updateInviteLabel as updateInviteLabelInDb,
  updateMessageStatus as updateMessageStatusInDb,
  updateMessageSentToRelays as updateMessageSentToRelaysInDb,
  updateMessageRecipientStatuses as updateMessageRecipientStatusesInDb,
  updateMessageDeliveryTrace as updateMessageDeliveryTraceInDb,
  saveProcessedEvent,
  getPendingPushEvents,
  deletePendingPushEvent,
  type StoredSession,
  type StoredMessage,
  type StoredInvite
} from './storage'
import { updateDMSubscription } from './notifications'
import { handleGroupEvent, handleGroupRosterFactRumor } from './groups'
import { parseReceipt, shouldAdvanceStatus, type ReceiptPayload, type MessageStatus } from './receipts'
import { receiptSettings } from './receiptSettings'
import { typingSettings } from './typingSettings'
import { setRemoteTyping, clearRemoteTyping } from './typingState'
import { expirationStore } from './expirationStore'
import { parseChatSettingsContent } from './chatSettings'
import { acceptChat } from './messageRequests'
import { getMessageRequestPolicyContext, isChatAccepted, shouldIgnoreIncomingEvent } from './messageRequestPolicy'
import { asVerifiedPushNostrEvent } from './pushEvents'
import { onMessageRelayPublish } from './messageRelayStatus'

export type RecipientDeliveryStatus = 'sent' | MessageStatus

export interface ChatMessage {
  id: string
  content: string
  timestamp: number
  isMine: boolean
  replyTo?: string  // ID of the message being replied to
  reactions?: Record<string, string[]>  // emoji -> array of pubkeys who reacted
  status?: MessageStatus
  sentToRelays?: string[]
  recipientStatuses?: Record<string, RecipientDeliveryStatus>
  deliveryChannels?: string[]
  outerEventIds?: string[]
  pendingRelayEventIds?: string[]
  senderPubkey?: string  // pubkey of sender (for group messages)
  expiresAt?: number  // Unix timestamp in seconds when message expires (NIP-40)
}

export interface ChatSession {
  id: string
  recipientPubkey: string
  mode: 'manager'
  messages: ChatMessage[]
  inviteId?: string      // ID of the invite that started this chat
  inviteLabel?: string   // Label of the invite that started this chat
}

export type ChatInvite =
  | { type: 'pubkey'; pubkey: string }
  | { type: 'legacy'; invite: Invite }

export interface ActiveInvite {
  id: string
  invite: ChatInvite
  label?: string
  createdAt: number
  usedBy?: string[]
  unsubscribe: () => void
}

export const chats = writable<Map<string, ChatSession>>(new Map())
export const currentChat = writable<ChatSession | null>(null)
export const invites = writable<Map<string, ActiveInvite>>(new Map())
let isInitialized = false
let invitesInitialized = false
let runtimePoller: ReturnType<typeof setInterval> | null = null

let runtimeSessionSubscribed = false
let runtimeSubscriptionPromise: Promise<void> | null = null
let runtimeSessionEventCleanup: (() => void) | null = null
let groupRuntimeSubscribed = false
let groupRuntimeCleanup: (() => void) | null = null
const managerChatBootstrapInFlight = new Set<string>()
const pendingAutoOpenChats = new Set<string>()
const autoOpenedChats = new Set<string>()

type SessionUserRecordEntry =
  SessionUserRecordsLike extends Map<string, infer Record> ? Record : never

function triggerAutoOpen(chatSession: ChatSession): void {
  if (autoOpenedChats.has(chatSession.id)) return
  if (inviteAcceptedCallback) {
    autoOpenedChats.add(chatSession.id)
    inviteAcceptedCallback(chatSession)
    return
  }
  pendingAutoOpenChats.add(chatSession.id)
}

function mergeChatMessages(messages: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>()
  for (const message of messages) {
    const existing = byId.get(message.id)
    if (!existing || existing.timestamp <= message.timestamp) {
      byId.set(message.id, message)
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.timestamp - b.timestamp)
}

async function persistCanonicalizedChat(
  previousId: string,
  canonicalChat: ChatSession
): Promise<void> {
  try {
    await saveSessionToStorage(canonicalChat)
    await Promise.all(
      canonicalChat.messages.map((message) =>
        saveMessageToStorage(canonicalChat.id, message)
      )
    )
    if (previousId !== canonicalChat.id) {
      await Promise.allSettled([
        deleteSessionFromDb(previousId),
        deleteMessagesForSession(previousId),
      ])
    }
  } catch (e) {
    console.error('[chat] Failed to persist canonicalized chat:', e)
  }
}

function canonicalizeManagerChatAlias(chatId: string, canonicalId: string): void {
  if (!chatId || !canonicalId || chatId === canonicalId) {
    return
  }

  const currentChats = get(chats)
  const aliasChat = currentChats.get(chatId)
  if (!aliasChat) {
    return
  }

  const canonicalChat = currentChats.get(canonicalId)
  const mergedChat: ChatSession = canonicalChat
    ? {
        ...canonicalChat,
        recipientPubkey: canonicalId,
        messages: mergeChatMessages([
          ...canonicalChat.messages,
          ...aliasChat.messages,
        ]),
        inviteId: canonicalChat.inviteId ?? aliasChat.inviteId,
        inviteLabel: canonicalChat.inviteLabel ?? aliasChat.inviteLabel,
      }
    : {
        ...aliasChat,
        id: canonicalId,
        recipientPubkey: canonicalId,
        messages: mergeChatMessages(aliasChat.messages),
      }

  chats.update((chatMap) => {
    chatMap.delete(chatId)
    chatMap.set(canonicalId, mergedChat)
    return chatMap
  })

  if (pendingAutoOpenChats.delete(chatId)) {
    pendingAutoOpenChats.add(canonicalId)
  }
  if (autoOpenedChats.delete(chatId)) {
    autoOpenedChats.add(canonicalId)
  }

  const current = get(currentChat)
  if (current?.id === chatId || current?.id === canonicalId) {
    currentChat.set(mergedChat)
  }

  void persistCanonicalizedChat(chatId, mergedChat)
}

function shouldSkipSelfCanonicalization(
  chatId: string,
  canonicalId: string,
  myPubkey?: string,
  authenticatedRemoteOwner?: string
): boolean {
  if (!myPubkey || canonicalId !== myPubkey || chatId === myPubkey) {
    return false
  }
  if (authenticatedRemoteOwner && chatId === authenticatedRemoteOwner) {
    return true
  }
  return !isKnownOwnDevice(chatId)
}

function canonicalizeKnownManagerChats(
  myPubkey?: string,
  authenticatedRemoteOwner?: string
): void {
  const currentChats = Array.from(get(chats).keys())
  for (const chatId of currentChats) {
    const canonicalId = resolveSessionPubkeyToOwner(chatId)
    if (shouldSkipSelfCanonicalization(chatId, canonicalId, myPubkey, authenticatedRemoteOwner)) {
      continue
    }
    if (canonicalId !== chatId) {
      canonicalizeManagerChatAlias(chatId, canonicalId)
    }
  }
}

function syncCurrentChatIfMatching(updatedSession: ChatSession): void {
  const current = get(currentChat)
  if (current?.id === updatedSession.id) {
    currentChat.set(updatedSession)
  }
}

function updateChatSession(
  sessionId: string,
  updater: (chatSession: ChatSession) => ChatSession | null
): ChatSession | null {
  let updatedSession: ChatSession | null = null

  chats.update((chatMap) => {
    const chatSession = chatMap.get(sessionId)
    if (!chatSession) {
      return chatMap
    }

    const nextSession = updater(chatSession)
    if (!nextSession) {
      return chatMap
    }

    chatMap.set(sessionId, nextSession)
    updatedSession = nextSession
    return chatMap
  })

  if (updatedSession) {
    syncCurrentChatIfMatching(updatedSession)
  }

  return updatedSession
}

function mergeRelayUrls(existing: string[] | undefined, next: string[]): string[] {
  return Array.from(
    new Set([...(existing || []), ...next].map((url) => url.trim()).filter(Boolean))
  ).sort()
}

function mergeStringList(existing: string[] | undefined, next: string[]): string[] {
  return Array.from(
    new Set([...(existing || []), ...next].map((value) => value.trim()).filter(Boolean))
  ).sort()
}

function relayChannelLabel(relayUrl: string): string {
  return `message server: ${relayUrl.trim()}`
}

function recipientStatusRank(status: RecipientDeliveryStatus | undefined): number {
  if (status === 'seen') return 3
  if (status === 'delivered') return 2
  if (status === 'sent') return 1
  return 0
}

function advanceRecipientStatus(
  existing: Record<string, RecipientDeliveryStatus> | undefined,
  pubkey: string,
  status: MessageStatus
): Record<string, RecipientDeliveryStatus> | null {
  const previous = existing?.[pubkey]
  if (recipientStatusRank(previous) >= recipientStatusRank(status)) return null
  return {
    ...(existing || {}),
    [pubkey]: status,
  }
}

function findChatSessionIdByMessageId(messageId: string): string | null {
  for (const [sessionId, chatSession] of get(chats)) {
    if (chatSession.messages.some((message) => message.id === messageId)) {
      return sessionId
    }
  }
  return null
}

function markMessageSentToRelays(messageId: string, relayUrls: string[]): void {
  const sessionId = findChatSessionIdByMessageId(messageId)
  if (!sessionId) return

  let sentToRelays: string[] | null = null
  let deliveryChannels: string[] | null = null
  const updatedSession = updateChatSession(sessionId, (latestSession) => {
    const messageIndex = latestSession.messages.findIndex((message) => message.id === messageId)
    if (messageIndex === -1) return null

    const message = latestSession.messages[messageIndex]
    const mergedRelays = mergeRelayUrls(message.sentToRelays, relayUrls)
    const currentRelays = message.sentToRelays || []
    const mergedChannels = mergeStringList(
      message.deliveryChannels,
      relayUrls.map(relayChannelLabel)
    )
    const currentChannels = message.deliveryChannels || []
    if (
      mergedRelays.length === currentRelays.length &&
      mergedRelays.every((url, index) => url === currentRelays[index]) &&
      mergedChannels.length === currentChannels.length &&
      mergedChannels.every((channel, index) => channel === currentChannels[index])
    ) {
      return null
    }

    const updatedMessages = [...latestSession.messages]
    updatedMessages[messageIndex] = {
      ...message,
      sentToRelays: mergedRelays,
      deliveryChannels: mergedChannels,
    }
    sentToRelays = mergedRelays
    deliveryChannels = mergedChannels
    return { ...latestSession, messages: updatedMessages }
  })
  if (!updatedSession || !sentToRelays || !deliveryChannels) return

  void updateMessageSentToRelaysInDb(messageId, sentToRelays).catch((error) => {
    console.error('[chat] Failed to persist message relay publish status:', error)
  })
  void updateMessageDeliveryTraceInDb(messageId, { deliveryChannels }).catch((error) => {
    console.error('[chat] Failed to persist message delivery channels:', error)
  })
}

onMessageRelayPublish(markMessageSentToRelays)

function subscribeToNdrRuntimeEvents(): void {
  if (runtimeSessionSubscribed) return
  runtimeSessionSubscribed = true
  runtimeSessionEventCleanup = getNdrRuntime().onSessionEvent((rumor, from, meta) => {
    handleManagerEvent(rumor, from, meta).catch((e) =>
      console.error('[chat] Failed to handle NdrRuntime event:', e)
    )
  })
}

function startNdrRuntimePoller(): void {
  if (!runtimePoller) {
    runtimePoller = setInterval(() => syncRuntimeChats(), 500)
    syncRuntimeChats()
  }
}

export function initNdrRuntimeEvents(): Promise<void> {
  if (!groupRuntimeSubscribed) {
    const runtime = getNdrRuntime()
    groupRuntimeSubscribed = true
    groupRuntimeCleanup = runtime.onGroupEvent((event) => {
      if (handleGroupRosterFactRumor(event.inner)) {
        return
      }
      const senderPubkey =
        event.senderOwnerPubkey || event.senderDevicePubkey || event.inner.pubkey
      handleGroupEvent(
        event.inner,
        senderPubkey,
        { id: event.outerEventId },
        event.senderDevicePubkey,
      )
    })
  }

  subscribeToNdrRuntimeEvents()

  if (getNdrRuntime().getState().sessionManagerReady) {
    startNdrRuntimePoller()
    return Promise.resolve()
  }

  // Runtime may still be initializing right after login. If we return early
  // we can miss the first incoming events and end up with chats that have sessions
  // but no messages. Wait for it and subscribe as soon as it's ready.
  if (!runtimeSubscriptionPromise) {
    runtimeSubscriptionPromise = waitForNdrRuntime()
      .then(() => startNdrRuntimePoller())
      .catch((e) => {
        console.error('[chat] Failed to init NdrRuntime events:', e)
        throw e
      })
      .finally(() => {
        runtimeSubscriptionPromise = null
      })
    void runtimeSubscriptionPromise.catch(() => {})
  }

  return runtimeSubscriptionPromise
}

const pushEventIngestInFlight = new Set<string>()

export async function ingestPushNostrEvent(event: unknown): Promise<boolean> {
  const verifiedEvent = asVerifiedPushNostrEvent(event)
  if (!verifiedEvent?.id) return false
  if (pushEventIngestInFlight.has(verifiedEvent.id)) return false

  pushEventIngestInFlight.add(verifiedEvent.id)
  try {
    await initNdrRuntimeEvents()
    const handled = getNdrRuntime().processReceivedEvent(verifiedEvent)
    await deletePendingPushEvent(verifiedEvent.id)
    if (handled) {
      updateDMSubscription()
    }
    return handled
  } catch (error) {
    console.error('[chat] Failed to ingest push Nostr event:', error)
    return false
  } finally {
    pushEventIngestInFlight.delete(verifiedEvent.id)
  }
}

export async function drainPendingPushNostrEvents(): Promise<void> {
  const pending = await getPendingPushEvents()
  for (const record of pending) {
    await ingestPushNostrEvent(record.event)
  }
}

function syncRuntimeChats(): void {
  const myPubkey = getPubkey()
  if (!myPubkey) return

  canonicalizeKnownManagerChats()

  const policyCtx = getMessageRequestPolicyContext()

  const currentChats = get(chats)
  const runtime = getNdrRuntime()
  for (const [pubkey, record] of runtime.getSessionUserRecords()) {
    if (pubkey === myPubkey) continue
    if (needsManagerUserSetup(record)) {
      void runtime.setupUser(pubkey).catch((e) =>
        console.error('[chat] Failed to refresh runtime user setup:', e)
      )
    }
    if (currentChats.has(pubkey)) continue
    if (policyCtx.rejectedChats?.[pubkey]) continue
    if (
      policyCtx.receiveMessageRequests === false &&
      !policyCtx.following.has(pubkey) &&
      !policyCtx.acceptedChats?.[pubkey]
    ) {
      continue
    }

    const hasSession = Array.from(record.devices?.values() ?? []).some((device) =>
      Boolean(device.activeSession) || (device.inactiveSessions?.length ?? 0) > 0
    )
    if (!hasSession) continue

    ensureManagerChat(pubkey).catch((e) =>
      console.error('[chat] Failed to sync manager chat:', e)
    )
  }
}

export function needsManagerUserSetup(record: SessionUserRecordEntry): boolean {
  const devicesMap = record.devices ?? new Map()
  const knownDeviceCount = devicesMap.size
  const appKeysDeviceCount = record.appKeys?.getAllDevices?.().length ?? 0

  if (appKeysDeviceCount > knownDeviceCount) {
    return true
  }

  return Array.from(devicesMap.values()).some(
    (device) => !device.activeSession && (device.inactiveSessions?.length ?? 0) === 0
  )
}

// Create a new invite (chat link) that can be shared privately.
export async function createInvite(): Promise<ChatInvite> {
  const pubkey = getPubkey()
  if (!pubkey) throw new Error('Not logged in')

  const runtime = await waitForNdrRuntime()
  const delegateInvite = runtime.getDelegateManager()?.getInvite()
  if (!delegateInvite) {
    throw new Error('Invite is not ready')
  }

  registerDeviceInBackground('creating invite')

  const invite = Invite.deserialize(delegateInvite.serialize())
  invite.ownerPubkey = pubkey
  return { type: 'legacy', invite }
}

// Get the base URL for invite links
function getInviteBaseUrl(): string {
  const origin = window.location.origin
  if (origin.startsWith('http://localhost') ||
      origin.startsWith('http://127.0.0.1')) {
    return 'https://chat.iris.to'
  }
  return origin
}

// Get invite URL
export function getInviteUrl(invite: ChatInvite): string {
  if (invite.type === 'pubkey') {
    const url = new URL(getInviteBaseUrl())
    url.hash = `/${nip19.npubEncode(invite.pubkey)}`
    return url.toString()
  }
  return routeInviteUrl(invite.invite.getUrl(getInviteBaseUrl()))
}

function routeInviteUrl(inviteUrl: string): string {
  const url = new URL(inviteUrl)
  let payload = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
  payload = payload.replace(/^\/+/, '')
  if (!payload || payload.toLowerCase().startsWith('invite/')) {
    return url.toString()
  }
  url.hash = `/invite/${payload}`
  return url.toString()
}

function parseInviteHash(hash: string): ChatInvite | null {
  let raw = hash.startsWith('#') ? hash.slice(1) : hash
  // Some environments/libraries produce hashes like "#/npub..." (hash-routing style).
  raw = raw.replace(/^\/+/, '')
  if (raw.toLowerCase().startsWith('invite/')) {
    raw = raw.slice('invite/'.length).replace(/^\/+/, '')
  }
  if (!raw) return null

  type InvitePurpose = 'link' | 'chat'
  const parseInvitePayload = (
    payload: string
  ): { purpose?: InvitePurpose; owner?: string } | null => {
    try {
      const decoded = decodeURIComponent(payload)
      const data = JSON.parse(decoded) as Record<string, unknown>
      if (!data || typeof data !== 'object') return null
      return {
        purpose:
          data.purpose === 'link' || data.purpose === 'chat'
            ? (data.purpose as InvitePurpose)
            : undefined,
        owner:
          typeof data.owner === 'string'
            ? data.owner
            : typeof data.ownerPubkey === 'string'
              ? data.ownerPubkey
              : undefined,
      }
    } catch {
      return null
    }
  }

  const normalizeInvitePayload = (payload: string): string | null => {
    try {
      const decoded = decodeURIComponent(payload)
      const data = JSON.parse(decoded) as Record<string, unknown>
      if (!data || typeof data !== 'object') return null

      if (
        typeof data.inviterEphemeralPublicKey === 'string' &&
        typeof data.ephemeralKey !== 'string'
      ) {
        data.ephemeralKey = data.inviterEphemeralPublicKey
      }

      if (
        typeof data.inviter !== 'string' ||
        typeof data.ephemeralKey !== 'string' ||
        typeof data.sharedSecret !== 'string'
      ) {
        return null
      }

      return JSON.stringify(data)
    } catch {
      return null
    }
  }

  // NIP-19 links (npub or nprofile)
  if (raw.startsWith('npub') || raw.startsWith('nprofile')) {
    try {
      const decoded = nip19.decode(raw)
      if (decoded.type === 'npub') {
        return { type: 'pubkey', pubkey: decoded.data as string }
      }
      if (decoded.type === 'nprofile') {
        const data = decoded.data as { pubkey: string }
        return { type: 'pubkey', pubkey: data.pubkey }
      }
    } catch {
      return null
    }
  }

  // Legacy JSON invite format
  const applyPayloadMeta = (invite: Invite, payloadRaw: string) => {
    const payload = parseInvitePayload(payloadRaw)
    if (payload?.purpose) {
      invite.purpose = payload.purpose
    }
    if (payload?.owner) {
      ;(invite as Invite & { ownerPubkey?: string }).ownerPubkey = payload.owner
    }
    return invite
  }

  try {
    const url = `${getInviteBaseUrl()}#${raw}`
    const invite = Invite.fromUrl(url)
    return { type: 'legacy', invite: applyPayloadMeta(invite, raw) }
  } catch {
    const normalizedPayload = normalizeInvitePayload(raw)
    if (!normalizedPayload) return null
    try {
      const url = `${getInviteBaseUrl()}#${encodeURIComponent(normalizedPayload)}`
      const invite = Invite.fromUrl(url)
      return { type: 'legacy', invite: applyPayloadMeta(invite, raw) }
    } catch {
      return null
    }
  }
}

// Parse invite from URL hash
export function parseInviteFromHash(): ChatInvite | null {
  const hash = window.location.hash
  if (!hash || hash.length < 2) return null
  return parseInviteHash(hash)
}

// Parse invite from a pasted URL
export function parseInviteFromUrl(url: string): ChatInvite | null {
  try {
    const trimmed = url.trim()
    if (trimmed.startsWith('npub') || trimmed.startsWith('nprofile')) {
      return parseInviteHash(`#${trimmed}`)
    }
    if (trimmed.startsWith('nostr:')) {
      const raw = trimmed.replace('nostr:', '')
      return parseInviteHash(`#${raw}`)
    }
    const parsed = new URL(url)
    return parseInviteHash(parsed.hash)
  } catch {
    return null
  }
}

export function isLinkInvite(invite: ChatInvite | null | undefined): boolean {
  if (!invite || invite.type !== 'legacy') return false
  const withPurpose = invite.invite as Invite & { purpose?: string }
  return withPurpose.purpose === 'link'
}

// Serialize invite for storage
export function serializeInvite(invite: ChatInvite): string {
  if (invite.type === 'pubkey') {
    return JSON.stringify({ type: 'pubkey', pubkey: invite.pubkey })
  }
  return invite.invite.serialize()
}

// Deserialize invite from storage
export function deserializeInvite(data: string): ChatInvite {
  try {
    const parsed = JSON.parse(data)
    if (parsed?.type === 'pubkey' && typeof parsed.pubkey === 'string') {
      return { type: 'pubkey', pubkey: parsed.pubkey }
    }
    if (parsed?.type === 'legacy' && typeof parsed.data === 'string') {
      return { type: 'legacy', invite: Invite.deserialize(parsed.data) }
    }
  } catch {
    // fall back to legacy invite
  }
  return { type: 'legacy', invite: Invite.deserialize(data) }
}

// Callback for when an invite is accepted
let inviteAcceptedCallback: ((session: ChatSession) => void) | null = null

// Set callback for invite acceptance (called from App.svelte)
export function setInviteAcceptedCallback(callback: (session: ChatSession) => void): void {
  inviteAcceptedCallback = callback
  if (pendingAutoOpenChats.size === 0) return
  const chatMap = get(chats)
  for (const chatId of pendingAutoOpenChats) {
    const chatSession = chatMap.get(chatId)
    if (!chatSession) continue
    autoOpenedChats.add(chatId)
    inviteAcceptedCallback(chatSession)
  }
  pendingAutoOpenChats.clear()
}

// Create a new invite and save to storage
export async function createAndSaveInvite(label?: string): Promise<ActiveInvite> {
  const pubkey = getPubkey()
  if (!pubkey) throw new Error('Not logged in')

  const invite = await createInvite()
  const id = crypto.randomUUID()

  // Save to IndexedDB
  const storedInvite: StoredInvite = {
    id,
    inviteData: serializeInvite(invite),
    label,
    createdAt: Date.now(),
    usedBy: []
  }
  await saveInviteToDb(storedInvite)

  const unsubscribe = () => {}

  const activeInvite: ActiveInvite = {
    id,
    invite,
    label,
    createdAt: storedInvite.createdAt,
    usedBy: [],
    unsubscribe
  }

  // Add to invites store
  invites.update(i => {
    i.set(id, activeInvite)
    return i
  })

  // Update notification subscription to include this invite's ephemeral key
  updateDMSubscription()

  return activeInvite
}

// Delete a stored invite and stop listening
export async function deleteStoredInvite(id: string): Promise<void> {
  const currentInvites = get(invites)
  const activeInvite = currentInvites.get(id)

  if (activeInvite) {
    // Stop listening
    activeInvite.unsubscribe()
  }

  // Remove from store
  invites.update(i => {
    i.delete(id)
    return i
  })

  // Delete from storage
  await deleteInviteFromDb(id)

  // Update notification subscription
  updateDMSubscription()
}

// Update label on an invite
export async function updateInviteLabel(id: string, label: string): Promise<void> {
  await updateInviteLabelInDb(id, label)

  // Update in store
  invites.update(i => {
    const activeInvite = i.get(id)
    if (activeInvite) {
      i.set(id, { ...activeInvite, label })
    }
    return i
  })
}

// Load all invites from storage and start monitoring
export async function loadAndMonitorInvites(): Promise<void> {
  if (invitesInitialized) {
    return
  }

  try {
    const storedInvites = await getAllInvites()

    for (const stored of storedInvites) {
      try {
        const invite = deserializeInvite(stored.inviteData)
        if (invite.type === 'pubkey') {
          await deleteInviteFromDb(stored.id)
          continue
        }
        const unsubscribe = () => {}

        const activeInvite: ActiveInvite = {
          id: stored.id,
          invite,
          label: stored.label,
          createdAt: stored.createdAt,
          usedBy: stored.usedBy || [],
          unsubscribe
        }

        // Add to invites store
        invites.update(i => {
          i.set(stored.id, activeInvite)
          return i
        })
      } catch (e) {
        console.error('[chat] Failed to restore invite:', stored.id, e)
      }
    }

    invitesInitialized = true
  } catch (e) {
    console.error('Failed to load invites from storage:', e)
  }
}

// Get all invite ephemeral pubkeys for notifications
export function getInviteEphemeralPubkeys(): string[] {
  const currentInvites = get(invites)
  const pubkeys: string[] = []

  for (const [, activeInvite] of currentInvites) {
    if (activeInvite.invite.type === 'legacy') {
      // Get the ephemeral pubkey from the invite that responses will be sent to
      if (activeInvite.invite.invite.inviterEphemeralPublicKey) {
        pubkeys.push(activeInvite.invite.invite.inviterEphemeralPublicKey)
      }
    }
  }

  return pubkeys
}

type InviteSessionStateLike = {
  ourCurrentNostrKey?: {
    publicKey?: unknown
  } | null
}

function getSessionInvitePublicKey(session: unknown): string | null {
  const rawState =
    (session as { state?: unknown } | null | undefined)?.state ??
    (session as { sessionState?: unknown } | null | undefined)?.sessionState

  if (!rawState) return null

  let state: InviteSessionStateLike
  if (typeof rawState === 'string') {
    try {
      state = JSON.parse(rawState) as InviteSessionStateLike
    } catch {
      return null
    }
  } else {
    state = rawState as InviteSessionStateLike
  }

  const publicKey = state.ourCurrentNostrKey?.publicKey
  return typeof publicKey === 'string' ? publicKey : null
}

function isSessionFromLocalInvite(
  session: unknown,
  inviteEphemeralPubkeys: Set<string>
): boolean {
  const publicKey = getSessionInvitePublicKey(session)
  return !!publicKey && inviteEphemeralPubkeys.has(publicKey)
}

function isChatFromLocalInvite(chatId: string): boolean {
  const inviteEphemeralPubkeys = new Set(getInviteEphemeralPubkeys())
  if (inviteEphemeralPubkeys.size === 0) return false

  const runtime = getNdrRuntime()
  const userRecords = runtime.getSessionUserRecords() as
    | SessionUserRecordsLike
    | undefined
  if (!userRecords) return false

  const canonicalChatId = resolveSessionPubkeyToOwner(chatId)
  const recordsToCheck = [
    userRecords.get(chatId),
    canonicalChatId !== chatId ? userRecords.get(canonicalChatId) : undefined,
  ]

  for (const record of recordsToCheck) {
    const devicesMap = record?.devices ?? new Map()
    for (const device of devicesMap.values()) {
      const sessions = [
        device.activeSession,
        ...(device.inactiveSessions ?? []),
      ].filter(Boolean)

      if (sessions.some((session) => isSessionFromLocalInvite(session, inviteEphemeralPubkeys))) {
        return true
      }
    }
  }

  return false
}

async function ensureManagerChat(
  recipientPubkey: string,
  options: { bootstrap?: boolean } = {}
): Promise<ChatSession> {
  const { bootstrap = true } = options
  const existing = get(chats).get(recipientPubkey)
  if (existing) return existing

  const storedMessages = await getMessagesForSession(recipientPubkey)
  const messages: ChatMessage[] = storedMessages
    .map((m) => ({
      id: m.id,
      content: m.content,
      timestamp: m.timestamp,
      isMine: m.isMine,
      ...(m.replyTo && { replyTo: m.replyTo }),
      reactions: m.reactions,
      status: m.status,
      ...(m.sentToRelays && { sentToRelays: m.sentToRelays }),
      ...(m.recipientStatuses && { recipientStatuses: m.recipientStatuses }),
      ...(m.deliveryChannels && { deliveryChannels: m.deliveryChannels }),
      ...(m.outerEventIds && { outerEventIds: m.outerEventIds }),
      ...(m.pendingRelayEventIds && { pendingRelayEventIds: m.pendingRelayEventIds }),
      senderPubkey: m.senderPubkey,
      ...(m.expiresAt !== undefined && { expiresAt: m.expiresAt }),
    }))
    .sort((a, b) => a.timestamp - b.timestamp)

  const chatSession: ChatSession = {
    id: recipientPubkey,
    recipientPubkey,
    mode: 'manager',
    messages,
  }

  chats.update((c) => {
    c.set(chatSession.id, chatSession)
    return c
  })

  await saveSessionToStorage(chatSession)
  updateDMSubscription()
  if (bootstrap) {
    bootstrapManagerChatSession(recipientPubkey)
  }

  return chatSession
}

function bootstrapManagerChatSession(recipientPubkey: string): void {
  const myPubkey = getPubkey()
  if (!recipientPubkey || recipientPubkey === myPubkey) {
    return
  }
  if (managerChatBootstrapInFlight.has(recipientPubkey)) {
    return
  }

  managerChatBootstrapInFlight.add(recipientPubkey)
  void preparePeerNdrRuntime(recipientPubkey)
    .catch((e) =>
      console.warn('[chat] Failed to bootstrap manager chat session:', recipientPubkey, e)
    )
    .finally(() => {
      managerChatBootstrapInFlight.delete(recipientPubkey)
    })
}

function resolveManagerSender(fromPubkey: string, myPubkey: string | null): string {
  if (!myPubkey) return fromPubkey
  if (fromPubkey === myPubkey) return fromPubkey

  const deviceState = get(devices)
  const isOwnDevice =
    deviceState.identityPubkey === fromPubkey ||
    deviceState.registeredDevices.some((device) => device.identityPubkey === fromPubkey)

  return isOwnDevice ? myPubkey : fromPubkey
}

function resolveSessionPubkeyToOwner(pubkey: string): string {
  if (!pubkey) return pubkey

  const userRecords = getNdrRuntime().getSessionUserRecords() as
    | SessionUserRecordsLike
    | undefined
  if (!userRecords) return pubkey
  return resolveSessionPubkeyToOwnerFromRecords(userRecords, pubkey)
}

function isKnownOwnDevice(pubkey: string): boolean {
  const deviceState = get(devices)
  const runtimeState = getNdrRuntime().getState()
  return (
    deviceState.identityPubkey === pubkey ||
    deviceState.registeredDevices.some((device) => device.identityPubkey === pubkey) ||
    runtimeState.currentDevicePubkey === pubkey ||
    (runtimeState.registeredDevices?.some((device) => device.identityPubkey === pubkey) ?? false)
  )
}

function firstPubkeyTag(rumor: Rumor): string | undefined {
  const raw = rumor.tags?.find((t: string[]) => t[0] === 'p')?.[1]?.trim()
  return raw || undefined
}

function resolvePeerTagForChat(rawPeerTag: string, myPubkey: string): string {
  const resolvedPeer = resolveSessionPubkeyToOwner(rawPeerTag)
  if (resolvedPeer && resolvedPeer !== myPubkey) {
    return resolvedPeer
  }
  return rawPeerTag
}

function resolveManagerIsFromSelf(
  rumor: Rumor,
  chatId: string,
  effectiveFromPubkey: string,
  myPubkey: string,
  meta?: OnEventMeta
): boolean {
  if (meta?.isSelf) return true
  if (meta?.senderOwnerPubkey === myPubkey) return true
  if (meta?.senderOwnerPubkey && meta.senderOwnerPubkey !== myPubkey) return false
  if (effectiveFromPubkey === myPubkey) return true
  if (rumor.pubkey === myPubkey) return true
  if (isKnownOwnDevice(rumor.pubkey)) return true

  const pTag = firstPubkeyTag(rumor)
  const resolvedPTag = pTag ? resolvePeerTagForChat(pTag, myPubkey) : undefined
  // Sender copies from another client can be surfaced via the peer user record.
  return !!resolvedPTag && resolvedPTag !== myPubkey && resolvedPTag === chatId
}

export async function handleManagerEvent(
  rumor: Rumor,
  fromPubkey: string,
  meta?: OnEventMeta
): Promise<void> {
  const myPubkey = getPubkey()
  if (!myPubkey) return

  const effectiveFromPubkey = resolveManagerSender(fromPubkey, myPubkey)
  const resolvedFromPubkey = resolveSessionPubkeyToOwner(effectiveFromPubkey)
  const authenticatedRemoteOwner =
    meta?.senderOwnerPubkey && meta.senderOwnerPubkey !== myPubkey
      ? meta.senderOwnerPubkey
      : undefined

  const groupTag = rumor.tags?.find((t: string[]) => t[0] === 'l')
  if (groupTag) {
    return
  }

  let chatId = authenticatedRemoteOwner || resolvedFromPubkey
  const senderResolvesToSelf =
    !authenticatedRemoteOwner &&
    (meta?.isSelf === true ||
      meta?.senderOwnerPubkey === myPubkey ||
      effectiveFromPubkey === myPubkey ||
      resolvedFromPubkey === myPubkey)

  if (senderResolvesToSelf) {
    const pTag = firstPubkeyTag(rumor)
    const resolvedPTag = pTag ? resolvePeerTagForChat(pTag, myPubkey) : undefined
    if (pTag && pTag !== myPubkey && resolvedPTag && resolvedPTag !== myPubkey) {
      chatId = resolvedPTag
    } else if (pTag && pTag !== myPubkey) {
      chatId = pTag
    } else {
      // Self-message (p-tag is us or missing): route to self chat
      chatId = myPubkey
    }
  }

  canonicalizeKnownManagerChats(myPubkey, authenticatedRemoteOwner)
  const canonicalFromPubkey = resolveSessionPubkeyToOwner(fromPubkey)
  if (
    canonicalFromPubkey !== fromPubkey &&
    !shouldSkipSelfCanonicalization(
      fromPubkey,
      canonicalFromPubkey,
      myPubkey,
      authenticatedRemoteOwner
    )
  ) {
    canonicalizeManagerChatAlias(fromPubkey, canonicalFromPubkey)
  }
  if (effectiveFromPubkey !== chatId) {
    const canonicalEffectiveFromPubkey = resolveSessionPubkeyToOwner(effectiveFromPubkey)
    const canonicalEffectiveChatId =
      canonicalEffectiveFromPubkey === myPubkey ? chatId : canonicalEffectiveFromPubkey
    if (
      !shouldSkipSelfCanonicalization(
        effectiveFromPubkey,
        canonicalEffectiveChatId,
        myPubkey,
        authenticatedRemoteOwner
      )
    ) {
      canonicalizeManagerChatAlias(effectiveFromPubkey, canonicalEffectiveChatId)
    }
  }

  const isFromSelf = resolveManagerIsFromSelf(
    rumor,
    chatId,
    effectiveFromPubkey,
    myPubkey,
    meta
  )

  const policyCtx = getMessageRequestPolicyContext()
  const existing = get(chats).get(chatId)
  const shouldIgnore = shouldIgnoreIncomingEvent(
    existing || { recipientPubkey: chatId, messages: [] },
    isFromSelf,
    policyCtx
  )
  if (shouldIgnore) return

  const chatSession = await ensureManagerChat(chatId)

  const isEmptyChat = (existing ? existing.messages.length : chatSession.messages.length) === 0
  const isFirstInboundMessage =
    !isFromSelf &&
    rumor.kind === CHAT_MESSAGE_KIND &&
    isEmptyChat

  if (isFirstInboundMessage) {
    if (!isChatAccepted(chatSession, policyCtx) && isChatFromLocalInvite(chatId)) {
      acceptChat(chatSession.recipientPubkey)
      triggerAutoOpen(chatSession)
    } else if (isChatAccepted(chatSession, policyCtx)) {
      triggerAutoOpen(chatSession)
    }
    // Republish our current device invite after the first successful inbound session
    // so it is present on relays without invalidating the runtime invite-response listener.
    void republishInvite().catch((e) =>
      console.warn('[chat] republishInvite failed:', e)
    )
  }
  const outerEventId = (meta as (OnEventMeta & { outerEventId?: string }) | undefined)?.outerEventId
  const receiptAuthorPubkey = isFromSelf ? myPubkey : chatId
  handleIncomingRumor(chatSession, rumor, isFromSelf, outerEventId, receiptAuthorPubkey)
}

// Accept an invite and create a session
export async function acceptInvite(invite: ChatInvite): Promise<ChatSession> {
  if (invite.type === 'pubkey') {
    const existing = get(chats).get(invite.pubkey)
    const myPubkey = getPubkey()
    const isSelfChat = !!myPubkey && invite.pubkey === myPubkey
    const requiresRuntimeReady =
      !existing &&
      !!myPubkey &&
      isSelfChat
    const runtimeReadyPromise = requiresRuntimeReady
      ? waitForNdrRuntime()
          .then(async (runtime) => {
            try {
              await runtime.setupUser(myPubkey)
            } catch (e) {
              console.warn('[chat] Failed to bootstrap self user during acceptInvite:', e)
            }
            return runtime
          })
          .catch((e) => {
            console.warn('[chat] waitForNdrRuntime failed during acceptInvite:', e)
            throw e
          })
      : null
    const chatSession = await ensureManagerChat(invite.pubkey, {
      bootstrap: isSelfChat,
    })
    // User-initiated join: treat as accepted even before sending a message.
    acceptChat(invite.pubkey)
    if (!existing && !isSelfChat) {
      void waitForSendReadyRuntime().catch((e) => {
        console.warn('[chat] Failed to pre-register device for pubkey invite:', e)
      })
    }
    if (!existing && runtimeReadyPromise) {
      await runtimeReadyPromise
    }
    return chatSession
  }

  const ownerPublicKey = invite.invite.ownerPubkey || invite.invite.inviter
  const existing = get(chats).get(ownerPublicKey)

  if (isNip07Login() && !hasNip44Support()) {
    throw new Error('NIP-07 extension does not support NIP-44')
  }

  // Legacy invite responses carry the owner claim; AppKeys relay verification
  // can catch up after the chat opens instead of blocking invite acceptance.
  registerDeviceInBackground('joining invite')
  const runtime = await waitForNdrRuntime()
  const accepted = await runtime.acceptInvite(invite.invite, { ownerPublicKey })
  const chatTarget = accepted.ownerPublicKey || ownerPublicKey
  const chatSession = await ensureManagerChat(chatTarget)
  acceptChat(chatSession.recipientPubkey)
  updateDMSubscription()
  return chatSession
}

function handleIncomingRumor(
  chatSession: ChatSession,
  rumor: Rumor,
  isFromSelfOverride?: boolean,
  outerEventId?: string,
  receiptAuthorPubkey?: string
) {
  const myPubkey = getPubkey()
  const sessionId = chatSession.id

  // Get current state from store (not the captured reference which may be stale)
  const currentChats = get(chats)
  const currentSession = currentChats.get(sessionId)
  if (!currentSession) return

  const isMine = isFromSelfOverride ?? rumor.pubkey === myPubkey

  // Route group events to group handler
  const groupTag = rumor.tags?.find((t: string[]) => t[0] === 'l')
  if (groupTag) {
    return
  }

  const processedId = rumor.id
  const saveProcessedRumor = (content?: string) => {
    const event = {
      id: processedId,
      kind: rumor.kind,
      chatId: sessionId,
      content,
      isSelfMessage: isMine,
      timestamp: Date.now(),
    }
    saveProcessedEvent(event)
    if (outerEventId && outerEventId !== processedId) {
      saveProcessedEvent({ ...event, id: outerEventId })
    }
  }

  // Dispatch on inner event kind
  if (rumor.kind === RECEIPT_KIND) {
    // Persist content ('delivered'|'seen') so the SW push handler can render
    // the right notification text via its fast path.
    saveProcessedRumor(rumor.content)
    const receipt = parseReceipt(rumor)
    if (!receipt) return
    handleIncomingReceipt(currentSession, receipt, isMine, receiptAuthorPubkey)
    return
  }

  if (rumor.kind === REACTION_KIND) {
    saveProcessedRumor(rumor.content)
    const parsed = parseReaction(rumor)
    const emoji = parsed?.emoji ?? rumor.content // fallback for old plain-emoji format
    const messageId = parsed?.messageId ?? rumor.tags?.find((t: string[]) => t[0] === 'e')?.[1]
    if (!emoji || !messageId) return
    handleIncomingReaction(currentSession, { messageId, emoji }, rumor.pubkey)
    return
  }

  if (rumor.kind === CHAT_SETTINGS_KIND) {
    saveProcessedRumor()
    const settings = parseChatSettingsContent(rumor.content)
    if (settings) {
      expirationStore.setExpiration(sessionId, settings.messageTtlSeconds)
    }
    return
  }

  if (isTyping(rumor)) {
    saveProcessedRumor()
    if (isMine) {
      return
    }
    const expiresAt = getExpirationTimestampSeconds(rumor)
    const nowSeconds = Math.floor(Date.now() / 1000)
    if (expiresAt !== undefined && expiresAt <= nowSeconds) {
      clearRemoteTyping(sessionId)
    } else {
      setRemoteTyping(sessionId, rumor.created_at)
    }
    return
  }

  // Incoming message clears typing indicator
  if (!isMine) {
    clearRemoteTyping(sessionId, rumor.created_at)
  }

  // Extract reply tag if present
  const replyTag = rumor.tags?.find(
    (tag: string[]) => tag[0] === 'e' && tag[3] === 'reply'
  )?.[1] || rumor.tags?.find(
    (tag: string[]) => tag[0] === 'e' && !rumor.tags?.some((t: string[]) => t[0] === 'e' && t[3] === 'root')
  )?.[1]

  // Message requests:
  // - if requests are disabled (or sender rejected), ignore all incoming events for unaccepted chats.
  // - do not send receipts for unaccepted chats.
  const policyCtx = getMessageRequestPolicyContext()
  const shouldIgnore = shouldIgnoreIncomingEvent(currentSession, isMine, policyCtx)
  if (shouldIgnore) return
  const chatAccepted = isChatAccepted(currentSession, policyCtx)

  // Auto-set delivered status for incoming messages
  const shouldAckDelivered = !isMine && get(receiptSettings).sendDeliveryReceipts && chatAccepted

  // Extract NIP-40 expiration tag
  const expiresAt = getExpirationTimestampSeconds(rumor)

  const message: ChatMessage = {
    id: processedId,
    content: rumor.content,
    timestamp: rumor.created_at * 1000,
    isMine,
    ...(replyTag && { replyTo: replyTag }),
    ...(shouldAckDelivered && { status: 'delivered' as const }),
    deliveryChannels: ['message servers'],
    outerEventIds: [outerEventId || processedId],
    ...(expiresAt !== undefined && { expiresAt }),
  }

  saveProcessedRumor(message.content)

  // Check if message already exists
  const updatedSession = updateChatSession(sessionId, (latestSession) => {
    if (latestSession.messages.some((m) => m.id === message.id)) {
      return null
    }

    const updatedMessages = [...latestSession.messages, message].sort(
      (a, b) => a.timestamp - b.timestamp
    )
    return { ...latestSession, messages: updatedMessages }
  })
  if (!updatedSession) return

  // Save message and updated session state to IndexedDB
  saveMessageToStorage(sessionId, message)
  saveSessionToStorage(updatedSession)

  // Send delivered receipt
  if (shouldAckDelivered) {
    sendReceipt(updatedSession, 'delivered', [message.id])
  }

  // Update notification subscription (debounced) since keys may have rotated
  updateDMSubscription()
}

// Handle incoming reaction
function handleIncomingReaction(chatSession: ChatSession, reaction: { messageId: string, emoji: string }, fromPubkey: string) {
  let updatedMessage: ChatMessage | null = null
  const updatedSession = updateChatSession(chatSession.id, (latestSession) => {
    const messageIndex = latestSession.messages.findIndex((m) => m.id === reaction.messageId)
    if (messageIndex === -1) return null

    const message = latestSession.messages[messageIndex]

    // Create updated reactions - first remove user from any existing reactions
    const reactions: Record<string, string[]> = {}
    for (const [emoji, users] of Object.entries(message.reactions || {})) {
      const filtered = users.filter((u) => u !== fromPubkey)
      if (filtered.length > 0) {
        reactions[emoji] = filtered
      }
    }

    // Add user to new reaction
    if (!reactions[reaction.emoji]) {
      reactions[reaction.emoji] = []
    }
    reactions[reaction.emoji] = [...reactions[reaction.emoji], fromPubkey]

    updatedMessage = { ...message, reactions }
    const updatedMessages = [...latestSession.messages]
    updatedMessages[messageIndex] = updatedMessage
    return { ...latestSession, messages: updatedMessages }
  })
  if (!updatedSession || !updatedMessage) return

  // Save updated message to IndexedDB
  saveMessageToStorage(chatSession.id, updatedMessage)
  saveSessionToStorage(updatedSession)
}

// Handle incoming receipt:
// - peer receipts advance status on our outgoing messages
// - self/own-device receipts advance status on incoming messages (cross-session unread sync)
function handleIncomingReceipt(
  chatSession: ChatSession,
  receipt: ReceiptPayload,
  isFromSelf: boolean,
  receiptAuthorPubkey?: string
) {
  const changedMessageStatuses: Array<{ messageId: string; status: MessageStatus }> = []
  const changedRecipientStatuses: Array<{
    messageId: string
    recipientStatuses: Record<string, RecipientDeliveryStatus>
  }> = []
  const updatedSession = updateChatSession(chatSession.id, (latestSession) => {
    let changed = false
    const updatedMessages = [...latestSession.messages]

    for (const messageId of receipt.messageIds) {
      const index = updatedMessages.findIndex(
        (m) => m.id === messageId && (isFromSelf ? !m.isMine : m.isMine)
      )
      if (index === -1) continue

      const message = updatedMessages[index]
      const nextRecipientStatuses =
        !isFromSelf && receiptAuthorPubkey
          ? advanceRecipientStatus(message.recipientStatuses, receiptAuthorPubkey, receipt.type)
          : null
      const nextStatus = shouldAdvanceStatus(message.status, receipt.type)
        ? receipt.type
        : message.status
      if (!nextRecipientStatuses && nextStatus === message.status) continue

      updatedMessages[index] = {
        ...message,
        status: nextStatus,
        ...(nextRecipientStatuses && { recipientStatuses: nextRecipientStatuses }),
      }
      if (nextStatus && nextStatus !== message.status) {
        changedMessageStatuses.push({ messageId, status: nextStatus })
      }
      if (nextRecipientStatuses) {
        changedRecipientStatuses.push({
          messageId,
          recipientStatuses: nextRecipientStatuses,
        })
      }
      changed = true
    }

    if (!changed) return null
    return { ...latestSession, messages: updatedMessages }
  })
  if (!updatedSession) return

  for (const { messageId, status } of changedMessageStatuses) {
    updateMessageStatusInDb(messageId, status)
  }
  for (const { messageId, recipientStatuses } of changedRecipientStatuses) {
    updateMessageRecipientStatusesInDb(messageId, recipientStatuses)
  }
}

function getManagerRumorAuthorPubkey(): string {
  const ownerPubkey = getPubkey()?.trim()
  if (ownerPubkey) {
    return ownerPubkey
  }

  const runtimeDeviceId = getNdrRuntime().getState().currentDevicePubkey?.trim()
  if (runtimeDeviceId) {
    return runtimeDeviceId
  }

  const deviceIdentityPubkey = get(devices).identityPubkey?.trim()
  if (deviceIdentityPubkey) {
    return deviceIdentityPubkey
  }

  throw new Error('Not logged in')
}

function buildManagerRumorOptions(recipientPubkey: string, tags: string[][] = []) {
  return {
    pubkey: getManagerRumorAuthorPubkey(),
    tags: ensureRecipientTag(tags, recipientPubkey),
  }
}

function registerDeviceInBackground(context: string): void {
  void ensureDeviceRegistered().catch((e) =>
    console.warn(`[chat] Device registration failed while ${context}:`, e)
  )
}

function sendRuntimeEvent(
  recipientPubkey: string,
  event: Partial<Rumor>,
  context: string
): void {
  registerDeviceInBackground(context)
  void waitForNdrRuntime()
    .then((runtime) => runtime.sendEvent(recipientPubkey, event))
    .catch((e) => console.error(`[chat] Failed to ${context} via NdrRuntime:`, e))
}

// Send a receipt via the double ratchet session
function sendReceipt(chatSession: ChatSession, type: 'delivered' | 'seen', messageIds: string[]): void {
  if (messageIds.length === 0) return

  sendRuntimeEvent(
    chatSession.recipientPubkey,
    buildReceiptRumor(
      type,
      messageIds,
      buildManagerRumorOptions(chatSession.recipientPubkey)
    ),
    'send receipt'
  )
}

// Send seen receipts for incoming messages - called from ChatView
export function sendSeenReceipts(chatSession: ChatSession, messageIds: string[]): void {
  // Get current state from store
  const currentChats = get(chats)
  const currentSession = currentChats.get(chatSession.id)
  if (!currentSession) return

  // Filter to only messages we haven't already acked as seen
  const toAck = messageIds.filter(id => {
    const msg = currentSession.messages.find(m => m.id === id)
    return msg && msg.status !== 'seen'
  })
  if (toAck.length === 0) return

  const updatedSession = updateChatSession(chatSession.id, (latestSession) => ({
    ...latestSession,
    messages: latestSession.messages.map((m) => {
      if (toAck.includes(m.id)) {
        return { ...m, status: 'seen' as const }
      }
      return m
    }),
  }))
  if (!updatedSession) return

  for (const messageId of toAck) {
    updateMessageStatusInDb(messageId, 'seen')
  }

  const policyCtx = getMessageRequestPolicyContext()
  if (get(receiptSettings).sendReadReceipts && isChatAccepted(updatedSession, policyCtx)) {
    sendReceipt(updatedSession, 'seen', toAck)
  }
}

// Send a message
export function sendMessage(chatSession: ChatSession, text: string, replyTo?: string): void {
  const tags: string[][] = []
  if (replyTo) {
    tags.push(['e', replyTo, '', 'reply'])
  }

  const rumor = buildTextRumor(
    text,
    buildManagerRumorOptions(chatSession.recipientPubkey, tags)
  )
  const messageId = rumor.id
  sendRuntimeEvent(chatSession.recipientPubkey, rumor, 'send message')

  // Get current state from store (not the passed reference which may be stale)
  const currentChats = get(chats)
  const currentSession = currentChats.get(chatSession.id)
  if (!currentSession) return

  // Sending a message is an implicit accept for message requests.
  const policyCtx = getMessageRequestPolicyContext()
  if (!isChatAccepted(currentSession, policyCtx)) {
    acceptChat(currentSession.recipientPubkey)
  }

  // Add message optimistically - use outer event ID for service worker lookup
  const message: ChatMessage = {
    id: messageId,
    content: text,
    timestamp: Date.now(),
    isMine: true,
    ...(replyTo && { replyTo }),
  }

  const updatedSession = updateChatSession(chatSession.id, (latestSession) => ({
    ...latestSession,
    messages: [...latestSession.messages, message],
  }))
  if (!updatedSession) return

  // Save and publish in background - don't block UI
  saveMessageToStorage(chatSession.id, message)
  saveSessionToStorage(updatedSession)

  // Update notification subscription (debounced) since keys may have rotated
  updateDMSubscription()
}

// Send a reaction to a message
export async function sendReaction(chatSession: ChatSession, messageId: string, emoji: string): Promise<void> {
  const rumor = buildReactionRumor(
    messageId,
    emoji,
    buildManagerRumorOptions(chatSession.recipientPubkey)
  )
  sendRuntimeEvent(chatSession.recipientPubkey, rumor, 'send reaction')

  // Get current state from store (not the passed reference which may be stale)
  const currentChats = get(chats)
  const currentSession = currentChats.get(chatSession.id)
  if (!currentSession) return

  // Add reaction optimistically
  const messageIndex = currentSession.messages.findIndex(m => m.id === messageId)
  let updatedMessage: ChatMessage | null = null

  if (messageIndex !== -1) {
    const message = currentSession.messages[messageIndex]
    const myPubkey = getPubkey()
    if (!myPubkey) return

    // Create updated reactions - first remove user from any existing reactions
    const reactions: Record<string, string[]> = {}
    for (const [existingEmoji, users] of Object.entries(message.reactions || {})) {
      const filtered = users.filter(u => u !== myPubkey)
      if (filtered.length > 0) {
        reactions[existingEmoji] = filtered
      }
    }

    // Add user to new reaction
    if (!reactions[emoji]) {
      reactions[emoji] = []
    }
    reactions[emoji] = [...reactions[emoji], myPubkey]

    // Create new message with reactions
    updatedMessage = { ...message, reactions }

    // Create new messages array for reactivity
    const updatedMessages = [...currentSession.messages]
    updatedMessages[messageIndex] = updatedMessage

    const updatedSession = updateChatSession(chatSession.id, (latestSession) => {
      const latestMessageIndex = latestSession.messages.findIndex((m) => m.id === messageId)
      if (latestMessageIndex === -1 || !updatedMessage) {
        return null
      }

      const latestMessages = [...latestSession.messages]
      latestMessages[latestMessageIndex] = updatedMessage
      return { ...latestSession, messages: latestMessages }
    })
    if (!updatedSession) return

    // Save updated message to IndexedDB
    await saveMessageToStorage(chatSession.id, updatedMessage)
    await saveSessionToStorage(updatedSession)
  }

  // No further action for manager mode (event already published)
}

// Delete a single message locally
export async function deleteMessage(sessionId: string, messageId: string): Promise<void> {
  // Get current state from store
  const currentChats = get(chats)
  const currentSession = currentChats.get(sessionId)
  if (!currentSession) return

  const updatedSession = updateChatSession(sessionId, (latestSession) => ({
    ...latestSession,
    messages: latestSession.messages.filter((m) => m.id !== messageId),
  }))
  if (!updatedSession) return

  // Delete from IndexedDB
  await deleteMessageFromDb(messageId)
}

// Leave current chat
export function leaveChat(): void {
  currentChat.set(null)
  // Clear URL hash
  history.replaceState(null, '', window.location.pathname)
}

// Delete a chat completely
export function deleteChat(chatSession: ChatSession): void {
  getNdrRuntime().deleteChat(chatSession.recipientPubkey).catch(() => {})

  // Remove from store
  chats.update(c => {
    c.delete(chatSession.id)
    return c
  })

  // Clear current chat if it's this one
  const current = get(currentChat)
  if (current?.id === chatSession.id) {
    currentChat.set(null)
  }

  // Delete from storage in background
  deleteSessionFromDb(chatSession.id)
  deleteMessagesForSession(chatSession.id)

  // Clear URL hash
  history.replaceState(null, '', window.location.pathname)
}

// Storage helpers
export async function saveSessionToStorage(chatSession: ChatSession): Promise<void> {
  try {
    const storedSession: StoredSession = {
      id: chatSession.id,
      recipientPubkey: chatSession.recipientPubkey,
      createdAt: Date.now(),
      inviteId: chatSession.inviteId,
      inviteLabel: chatSession.inviteLabel,
      mode: 'manager',
    }
    await saveSessionToDb(storedSession)
  } catch (e) {
    console.error('Failed to save session to storage:', e)
  }
}

async function saveMessageToStorage(sessionId: string, message: ChatMessage): Promise<void> {
  try {
    // Deep clone reactions to make it IndexedDB-safe
    const reactions = message.reactions
      ? JSON.parse(JSON.stringify(message.reactions))
      : undefined

    const storedMessage: StoredMessage = {
      id: message.id,
      sessionId,
      content: message.content,
      timestamp: message.timestamp,
      isMine: message.isMine,
      ...(message.replyTo && { replyTo: message.replyTo }),
      reactions,
      status: message.status,
      ...(message.sentToRelays && { sentToRelays: message.sentToRelays }),
      ...(message.recipientStatuses && { recipientStatuses: message.recipientStatuses }),
      ...(message.deliveryChannels && { deliveryChannels: message.deliveryChannels }),
      ...(message.outerEventIds && { outerEventIds: message.outerEventIds }),
      ...(message.pendingRelayEventIds && { pendingRelayEventIds: message.pendingRelayEventIds }),
      ...(message.senderPubkey && { senderPubkey: message.senderPubkey }),
      ...(message.expiresAt !== undefined && { expiresAt: message.expiresAt }),
    }
    await saveMessageToDb(storedMessage)
  } catch (e) {
    console.error('Failed to save message to storage:', e)
  }
}

// Load chats from IndexedDB
export async function loadChatsFromStorage(): Promise<void> {
  if (isInitialized) return

  try {
    const storedSessions = await getAllSessions()
    initNdrRuntimeEvents()

    for (const stored of storedSessions) {
      try {
        const storedMessages = await getMessagesForSession(stored.id)
        const messages: ChatMessage[] = storedMessages
          .map(m => ({
            id: m.id,
            content: m.content,
            timestamp: m.timestamp,
            isMine: m.isMine,
            ...(m.replyTo && { replyTo: m.replyTo }),
            reactions: m.reactions,
            status: m.status,
            ...(m.sentToRelays && { sentToRelays: m.sentToRelays }),
            ...(m.recipientStatuses && { recipientStatuses: m.recipientStatuses }),
            ...(m.deliveryChannels && { deliveryChannels: m.deliveryChannels }),
            ...(m.outerEventIds && { outerEventIds: m.outerEventIds }),
            ...(m.pendingRelayEventIds && { pendingRelayEventIds: m.pendingRelayEventIds }),
            senderPubkey: m.senderPubkey,
            ...(m.expiresAt !== undefined && { expiresAt: m.expiresAt }),
          }))
          .sort((a, b) => a.timestamp - b.timestamp)

        const chatSession: ChatSession = {
          id: stored.id,
          recipientPubkey: stored.recipientPubkey,
          mode: 'manager',
          messages,
          inviteId: stored.inviteId,
          inviteLabel: stored.inviteLabel,
        }

        // Add to chats store
        chats.update(c => {
          c.set(chatSession.id, chatSession)
          return c
        })
      } catch (e) {
        console.error('Failed to restore session:', stored.id, e)
      }
    }

    canonicalizeKnownManagerChats()
    isInitialized = true
  } catch (e) {
    console.error('Failed to load chats from storage:', e)
  }
}

// Send a typing indicator event
export function sendTypingEvent(chatSession: ChatSession): void {
  if (!get(typingSettings).sendTypingIndicators) return

  // Don't reveal we're typing until a request is accepted.
  const policyCtx = getMessageRequestPolicyContext()
  if (!isChatAccepted(chatSession, policyCtx)) return

  sendRuntimeEvent(
    chatSession.recipientPubkey,
    buildTypingRumor(buildManagerRumorOptions(chatSession.recipientPubkey)),
    'send typing'
  )
}

// Clear all chat data (for logout)
export async function clearChatData(): Promise<void> {
  try {
    // Stop all invite listeners
    const currentInvites = get(invites)
    for (const [, activeInvite] of currentInvites) {
      activeInvite.unsubscribe()
    }

    await clearAllData()
    chats.set(new Map())
    currentChat.set(null)
    invites.set(new Map())
    isInitialized = false
    invitesInitialized = false
    runtimeSessionSubscribed = false
    runtimeSubscriptionPromise = null
    runtimeSessionEventCleanup?.()
    runtimeSessionEventCleanup = null
    groupRuntimeCleanup?.()
    groupRuntimeCleanup = null
    groupRuntimeSubscribed = false
    if (runtimePoller) {
      clearInterval(runtimePoller)
      runtimePoller = null
    }
    pendingAutoOpenChats.clear()
    autoOpenedChats.clear()
    pushEventIngestInFlight.clear()
  } catch (e) {
    console.error('Failed to clear chat data:', e)
  }
}

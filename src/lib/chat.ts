import { writable, get } from 'svelte/store'
import {
  Invite,
  type OnEventMeta,
  type Rumor,
  resolveSessionPubkeyToOwner as resolveSessionPubkeyToOwnerFromRecords,
  type SessionManager,
  type SessionUserRecordsLike,
  type UserRecord,
  REACTION_KIND,
  RECEIPT_KIND,
  CHAT_MESSAGE_KIND,
  CHAT_SETTINGS_KIND,
  parseReaction,
  isTyping,
  getExpirationTimestampSeconds,
} from 'nostr-double-ratchet'
export type { Invite } from 'nostr-double-ratchet'
import { getEventHash, nip19 } from 'nostr-tools'
import { getPubkey, hasNip44Support, isNip07Login } from './identity'
import { devices } from './devices'
import {
  ensureDeviceRegistered,
  getSessionManager,
  waitForPeerSendReadySessionManager,
  waitForSendReadySessionManager,
  waitForSessionManager,
  republishInvite,
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
  saveProcessedEvent,
  type StoredSession,
  type StoredMessage,
  type StoredInvite
} from './storage'
import { updateDMSubscription } from './notifications'
import { handleGroupEvent } from './groups'
import { parseReceipt, shouldAdvanceStatus, type ReceiptPayload, type MessageStatus } from './receipts'
import { receiptSettings } from './receiptSettings'
import { typingSettings } from './typingSettings'
import { setRemoteTyping, clearRemoteTyping } from './typingState'
import { expirationStore } from './expirationStore'
import { parseChatSettingsContent } from './chatSettings'
import { acceptChat } from './messageRequests'
import { getMessageRequestPolicyContext, isChatAccepted, shouldIgnoreIncomingEvent } from './messageRequestPolicy'

export interface ChatMessage {
  id: string
  content: string
  timestamp: number
  isMine: boolean
  replyTo?: string  // ID of the message being replied to
  reactions?: Record<string, string[]>  // emoji -> array of pubkeys who reacted
  status?: MessageStatus
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
let sessionManagerPoller: ReturnType<typeof setInterval> | null = null

let sessionManagerSubscribed = false
const managerChatBootstrapInFlight = new Set<string>()
const pendingAutoOpenChats = new Set<string>()
const autoOpenedChats = new Set<string>()

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

function canonicalizeKnownManagerChats(): void {
  const currentChats = Array.from(get(chats).keys())
  for (const chatId of currentChats) {
    const canonicalId = resolveSessionPubkeyToOwner(chatId)
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

export function initSessionManagerEvents(): void {
  if (sessionManagerSubscribed) return

  const subscribe = (manager: SessionManager) => {
    if (sessionManagerSubscribed) return
    sessionManagerSubscribed = true
    manager.onEvent((rumor, from, meta) => {
      handleManagerEvent(rumor, from, meta).catch((e) =>
        console.error('[chat] Failed to handle SessionManager event:', e)
      )
    })
    if (!sessionManagerPoller) {
      sessionManagerPoller = setInterval(() => syncManagerChats(manager), 500)
      syncManagerChats(manager)
    }
  }

  const manager = getSessionManager()
  if (manager) {
    subscribe(manager)
    return
  }

  // SessionManager may still be initializing (e.g. right after login). If we return early
  // we can miss the first incoming manager events and end up with chats that have sessions
  // but no messages. Wait for it and subscribe as soon as it's ready.
  void waitForSessionManager()
    .then(subscribe)
    .catch((e) => console.error('[chat] Failed to init SessionManager events:', e))
}

function syncManagerChats(manager: SessionManager): void {
  const myPubkey = getPubkey()
  if (!myPubkey) return

  canonicalizeKnownManagerChats()

  const policyCtx = getMessageRequestPolicyContext()

  const currentChats = get(chats)
  for (const [pubkey, record] of manager.getUserRecords()) {
    if (pubkey === myPubkey) continue
    if (needsManagerUserSetup(record)) {
      void manager.setupUser(pubkey).catch((e) =>
        console.error('[chat] Failed to refresh manager user setup:', e)
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

    const hasSession = Array.from(record.devices.values()).some((device) =>
      Boolean(device.activeSession) || device.inactiveSessions.length > 0
    )
    if (!hasSession) continue

    ensureManagerChat(pubkey).catch((e) =>
      console.error('[chat] Failed to sync manager chat:', e)
    )
  }
}

export function needsManagerUserSetup(record: UserRecord): boolean {
  const knownDeviceCount = record.devices.size
  const appKeysDeviceCount = record.appKeys?.getAllDevices().length ?? 0

  if (appKeysDeviceCount > knownDeviceCount) {
    return true
  }

  return Array.from(record.devices.values()).some(
    (device) => !device.activeSession && device.inactiveSessions.length === 0
  )
}

// Create a new invite (chat link) that can be shared
export function createInvite(): ChatInvite {
  const pubkey = getPubkey()
  if (!pubkey) throw new Error('Not logged in')
  return { type: 'pubkey', pubkey }
}

// Get the base URL for invite links
function getInviteBaseUrl(): string {
  const origin = window.location.origin
  // Use production URL for local/tauri environments
  if (origin.startsWith('tauri://') ||
      origin.startsWith('http://localhost') ||
      origin.startsWith('http://127.0.0.1')) {
    return 'https://chat.iris.to'
  }
  return origin
}

// Get invite URL
export function getInviteUrl(invite: ChatInvite): string {
  if (invite.type === 'pubkey') {
    const url = new URL(getInviteBaseUrl())
    url.hash = nip19.npubEncode(invite.pubkey)
    return url.toString()
  }
  return invite.invite.getUrl(getInviteBaseUrl())
}

function parseInviteHash(hash: string): ChatInvite | null {
  let raw = hash.startsWith('#') ? hash.slice(1) : hash
  // Some environments/libraries produce hashes like "#/npub..." (hash-routing style).
  raw = raw.replace(/^\/+/, '')
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

  // Sharing a pubkey invite before this device is published in AppKeys leaves
  // peers guessing which device should receive the first inbound message.
  await ensureDeviceRegistered()

  const invite = createInvite()
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
  void waitForPeerSendReadySessionManager(recipientPubkey)
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

  const manager = getSessionManager()
  const userRecords = manager?.getUserRecords() as SessionUserRecordsLike | undefined
  if (!userRecords) return pubkey
  return resolveSessionPubkeyToOwnerFromRecords(userRecords, pubkey)
}

function isKnownOwnDevice(pubkey: string): boolean {
  const deviceState = get(devices)
  return (
    deviceState.identityPubkey === pubkey ||
    deviceState.registeredDevices.some((device) => device.identityPubkey === pubkey)
  )
}

function resolveManagerIsFromSelf(
  rumor: Rumor,
  chatId: string,
  effectiveFromPubkey: string,
  myPubkey: string,
  meta?: OnEventMeta
): boolean {
  if (meta?.isSelf) return true
  if (effectiveFromPubkey === myPubkey) return true
  if (rumor.pubkey === myPubkey) return true
  if (isKnownOwnDevice(rumor.pubkey)) return true

  const pTag = rumor.tags?.find((t: string[]) => t[0] === 'p')?.[1]
  const resolvedPTag = pTag ? resolveSessionPubkeyToOwner(pTag) : undefined
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

  const groupTag = rumor.tags?.find((t: string[]) => t[0] === 'l')
  if (groupTag) {
    handleGroupEvent(rumor, effectiveFromPubkey, undefined, meta?.fromDeviceId)
    return
  }

  let chatId = resolvedFromPubkey
  const senderResolvesToSelf =
    meta?.isSelf === true ||
    meta?.senderOwnerPubkey === myPubkey ||
    effectiveFromPubkey === myPubkey ||
    resolvedFromPubkey === myPubkey

  if (senderResolvesToSelf) {
    const pTag = rumor.tags?.find((t: string[]) => t[0] === 'p')
    const resolvedPTag = pTag?.[1] ? resolveSessionPubkeyToOwner(pTag[1]) : undefined
    if (resolvedPTag && resolvedPTag !== myPubkey) {
      chatId = resolvedPTag
    } else {
      // Self-message (p-tag is us or missing): route to self chat
      chatId = myPubkey
    }
  }

  canonicalizeKnownManagerChats()
  const canonicalFromPubkey = resolveSessionPubkeyToOwner(fromPubkey)
  if (canonicalFromPubkey !== fromPubkey) {
    canonicalizeManagerChatAlias(fromPubkey, canonicalFromPubkey)
  }
  if (effectiveFromPubkey !== chatId) {
    const canonicalEffectiveFromPubkey = resolveSessionPubkeyToOwner(effectiveFromPubkey)
    canonicalizeManagerChatAlias(
      effectiveFromPubkey,
      canonicalEffectiveFromPubkey === myPubkey ? chatId : canonicalEffectiveFromPubkey
    )
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
    if (isChatAccepted(chatSession, policyCtx)) {
      triggerAutoOpen(chatSession)
    }
    // Republish our current device invite after the first successful inbound session
    // so it is present on relays without invalidating the SessionManager's invite-response listener.
    void republishInvite().catch((e) =>
      console.warn('[chat] republishInvite failed:', e)
    )
  }
  handleIncomingRumor(chatSession, rumor, isFromSelf)
}

// Accept an invite and create a session
export async function acceptInvite(invite: ChatInvite): Promise<ChatSession> {
  if (invite.type === 'pubkey') {
    const existing = get(chats).get(invite.pubkey)
    const myPubkey = getPubkey()
    const isSelfChat = !!myPubkey && invite.pubkey === myPubkey
    const requiresSessionManagerReady =
      !existing &&
      !!myPubkey &&
      isSelfChat
    const sessionManagerReadyPromise = requiresSessionManagerReady
      ? waitForSessionManager()
          .then(async (ready) => {
            try {
              await ready.setupUser(myPubkey)
            } catch (e) {
              console.warn('[chat] Failed to bootstrap self user during acceptInvite:', e)
            }
            return ready
          })
          .catch((e) => {
            console.warn('[chat] waitForSessionManager failed during acceptInvite:', e)
            throw e
          })
      : null
    const chatSession = await ensureManagerChat(invite.pubkey, {
      bootstrap: isSelfChat,
    })
    // User-initiated join: treat as accepted even before sending a message.
    acceptChat(invite.pubkey)
    if (!existing && !isSelfChat) {
      void waitForSendReadySessionManager().catch((e) => {
        console.warn('[chat] Failed to pre-register device for pubkey invite:', e)
      })
    }
    if (!existing && sessionManagerReadyPromise) {
      await sessionManagerReadyPromise
    }
    return chatSession
  }

  const ownerPublicKey = invite.invite.ownerPubkey || invite.invite.inviter
  const existing = get(chats).get(ownerPublicKey)

  if (isNip07Login() && !hasNip44Support()) {
    throw new Error('NIP-07 extension does not support NIP-44')
  }

  const manager = getSessionManager()
  const readyManager = manager || (await waitForSessionManager().catch(() => null))
  const managerWithInviteAccept = readyManager as
    | (SessionManager & {
        getDeviceId?: () => string
        acceptInvite: (
          invite: Invite,
          options?: { ownerPublicKey?: string }
        ) => Promise<{ ownerPublicKey?: string }>
      })
    | null

  if (!managerWithInviteAccept?.acceptInvite) {
    throw new Error('SessionManager is not available')
  }

  // Legacy invite responses need a stable owner claim so the inviter can route
  // the new session under the responder account rather than a transient device key.
  await ensureDeviceRegistered()
  const accepted = await managerWithInviteAccept.acceptInvite(invite.invite, { ownerPublicKey })
  const chatTarget = accepted.ownerPublicKey || ownerPublicKey
  const chatSession = await ensureManagerChat(chatTarget)
  acceptChat(chatSession.recipientPubkey)
  updateDMSubscription()
  return chatSession
}

function handleIncomingRumor(
  chatSession: ChatSession,
  rumor: Rumor,
  isFromSelfOverride?: boolean
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
    handleGroupEvent(rumor, chatSession.recipientPubkey, undefined, rumor.pubkey)
    return
  }

  const processedId = rumor.id

  // Dispatch on inner event kind
  if (rumor.kind === RECEIPT_KIND) {
    saveProcessedEvent({ id: processedId, kind: rumor.kind, chatId: sessionId, timestamp: Date.now() })
    const receipt = parseReceipt(rumor)
    if (!receipt) return
    handleIncomingReceipt(currentSession, receipt, isMine)
    return
  }

  if (rumor.kind === REACTION_KIND) {
    saveProcessedEvent({ id: processedId, kind: rumor.kind, chatId: sessionId, content: rumor.content, timestamp: Date.now() })
    const parsed = parseReaction(rumor)
    const emoji = parsed?.emoji ?? rumor.content // fallback for old plain-emoji format
    const messageId = parsed?.messageId ?? rumor.tags?.find((t: string[]) => t[0] === 'e')?.[1]
    if (!emoji || !messageId) return
    handleIncomingReaction(currentSession, { messageId, emoji }, rumor.pubkey)
    return
  }

  if (rumor.kind === CHAT_SETTINGS_KIND) {
    saveProcessedEvent({ id: processedId, kind: rumor.kind, chatId: sessionId, timestamp: Date.now() })
    const settings = parseChatSettingsContent(rumor.content)
    if (settings) {
      expirationStore.setExpiration(sessionId, settings.messageTtlSeconds)
    }
    return
  }

  if (isTyping(rumor)) {
    saveProcessedEvent({ id: processedId, kind: rumor.kind, chatId: sessionId, timestamp: Date.now() })
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
    ...(expiresAt !== undefined && { expiresAt }),
  }

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
function handleIncomingReceipt(chatSession: ChatSession, receipt: ReceiptPayload, isFromSelf: boolean) {
  const changedMessageIds: string[] = []
  const updatedSession = updateChatSession(chatSession.id, (latestSession) => {
    let changed = false
    const updatedMessages = [...latestSession.messages]

    for (const messageId of receipt.messageIds) {
      const index = updatedMessages.findIndex(
        (m) => m.id === messageId && (isFromSelf ? !m.isMine : m.isMine)
      )
      if (index === -1) continue

      const message = updatedMessages[index]
      if (!shouldAdvanceStatus(message.status, receipt.type)) continue

      updatedMessages[index] = { ...message, status: receipt.type }
      changedMessageIds.push(messageId)
      changed = true
    }

    if (!changed) return null
    return { ...latestSession, messages: updatedMessages }
  })
  if (!updatedSession) return

  for (const messageId of changedMessageIds) {
    updateMessageStatusInDb(messageId, receipt.type)
  }
}

function getManagerRumorAuthorPubkey(): string {
  const managerDeviceId = getSessionManager()?.getDeviceId()?.trim()
  if (managerDeviceId) {
    return managerDeviceId
  }

  const deviceIdentityPubkey = get(devices).identityPubkey?.trim()
  if (deviceIdentityPubkey) {
    return deviceIdentityPubkey
  }

  const ownerPubkey = getPubkey()?.trim()
  if (ownerPubkey) {
    return ownerPubkey
  }

  throw new Error('Not logged in')
}

function buildManagerRumor(recipientPubkey: string, partial: Partial<Rumor>): Rumor {
  const myPubkey = getManagerRumorAuthorPubkey()

  const now = Date.now()
  const tags = [...(partial.tags || [])]

  if (!tags.some((t) => t[0] === 'p' && t[1] === recipientPubkey)) {
    tags.unshift(['p', recipientPubkey])
  }

  if (!tags.some((t) => t[0] === 'ms')) {
    tags.push(['ms', String(now)])
  }

  const rumor: Rumor = {
    content: partial.content || '',
    kind: partial.kind || CHAT_MESSAGE_KIND,
    created_at: partial.created_at || Math.floor(now / 1000),
    tags,
    pubkey: myPubkey,
    id: '',
  }

  rumor.id = getEventHash(rumor)
  return rumor
}

// Send a receipt via the double ratchet session
function sendReceipt(chatSession: ChatSession, type: 'delivered' | 'seen', messageIds: string[]): void {
  if (messageIds.length === 0) return

  void waitForPeerSendReadySessionManager(chatSession.recipientPubkey)
    .then((ready) => ready.sendReceipt(chatSession.recipientPubkey, type, messageIds))
    .catch((e) => console.error('[chat] SessionManager not ready for receipt:', e))
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

  let messageId = ''
  const rumor = buildManagerRumor(chatSession.recipientPubkey, {
    content: text,
    kind: CHAT_MESSAGE_KIND,
    tags,
  })
  messageId = rumor.id
  // Always await device registration + SessionManager init. It is possible to have a
  // non-null manager while init is still in progress, and an unregistered owner-side
  // device cannot be trusted by linked recipients for multidevice fanout.
  void waitForPeerSendReadySessionManager(chatSession.recipientPubkey)
    .then((ready) => ready.sendEvent(chatSession.recipientPubkey, rumor))
    .catch((e) => console.error('[chat] Failed to send via SessionManager:', e))

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
  const rumor = buildManagerRumor(chatSession.recipientPubkey, {
    content: emoji,
    kind: REACTION_KIND,
    tags: [['e', messageId]],
  })
  void waitForPeerSendReadySessionManager(chatSession.recipientPubkey)
    .then((ready) => ready.sendEvent(chatSession.recipientPubkey, rumor))
    .catch((e) => console.error('[chat] Failed to send reaction via SessionManager:', e))

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
  const manager = getSessionManager()
  manager?.deleteChat(chatSession.recipientPubkey).catch(() => {})

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
    initSessionManagerEvents()

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

  void waitForPeerSendReadySessionManager(chatSession.recipientPubkey)
    .then((ready) => ready.sendTyping(chatSession.recipientPubkey))
    .catch((e) => console.error('[chat] SessionManager not ready for typing:', e))
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
    sessionManagerSubscribed = false
    if (sessionManagerPoller) {
      clearInterval(sessionManagerPoller)
      sessionManagerPoller = null
    }
    pendingAutoOpenChats.clear()
    autoOpenedChats.clear()
  } catch (e) {
    console.error('Failed to clear chat data:', e)
  }
}

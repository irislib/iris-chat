import { writable, get } from 'svelte/store'
import {
  Invite,
  Session,
  type Rumor,
  type NostrSubscribe,
  type EventCallback,
  type EncryptFunction,
  type DecryptFunction,
  type SessionManager,
  REACTION_KIND,
  RECEIPT_KIND,
  TYPING_KIND,
  CHAT_MESSAGE_KIND,
  parseReaction,
} from 'nostr-double-ratchet'
export type { Invite } from 'nostr-double-ratchet'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getEventHash, nip19 } from 'nostr-tools'
import { ndk, getPrivkeyBytes, getPubkey, isNip07Login } from './identity'
import { getSessionManager, waitForSessionManager, ensureDeviceRegistered } from './privateChats'

type OuterEvent = Parameters<EventCallback>[1]

// Get private key bytes OR null for NIP-07
function getPrivkeyBytesOrNull(): Uint8Array | null {
  const privkeyBytes = getPrivkeyBytes()
  if (privkeyBytes) {
    return privkeyBytes
  }
  return null
}

// Get encrypt function for NIP-07 or null for local key
function getNip07Encrypt(): EncryptFunction | null {
  if (isNip07Login() && window.nostr?.nip44) {
    return async (plaintext: string, pubkey: string) => {
      // Validate pubkey format (should be 64 hex chars)
      const isValidPubkey = /^[0-9a-f]{64}$/i.test(pubkey)
      console.log('[chat] NIP-07 encrypt called for pubkey:', pubkey, 'valid:', isValidPubkey, 'length:', pubkey.length)
      if (!isValidPubkey) {
        throw new Error(`Invalid pubkey format: expected 64 hex chars, got ${pubkey.length} chars`)
      }
      try {
        // NIP-07 nip44.encrypt takes (peer pubkey, plaintext) per NIP-07 spec
        const result = await window.nostr!.nip44!.encrypt(pubkey, plaintext)
        console.log('[chat] NIP-07 encrypt success')
        return result
      } catch (e) {
        console.error('[chat] NIP-07 encrypt error:', e)
        throw e
      }
    }
  }
  return null
}

// Get decrypt function for NIP-07 or null for local key
function getNip07Decrypt(): DecryptFunction | null {
  if (isNip07Login() && window.nostr?.nip44) {
    return async (ciphertext: string, pubkey: string) => {
      console.log('[chat] NIP-07 decrypt called for pubkey:', pubkey.slice(0, 8))
      try {
        // NIP-07 nip44.decrypt takes (pubkey, ciphertext)
        const result = await window.nostr!.nip44!.decrypt(pubkey, ciphertext)
        console.log('[chat] NIP-07 decrypt success')
        return result
      } catch (e) {
        console.error('[chat] NIP-07 decrypt error:', e)
        throw e
      }
    }
  }
  return null
}

// Get encryptor (Uint8Array or EncryptFunction) for accept()
function getEncryptor(): Uint8Array | EncryptFunction | null {
  const privkeyBytes = getPrivkeyBytesOrNull()
  if (privkeyBytes) {
    console.log('[chat] Using local private key for encryption')
    return privkeyBytes
  }
  const nip07Encrypt = getNip07Encrypt()
  if (nip07Encrypt) {
    console.log('[chat] Using NIP-07 nip44 for encryption')
    return nip07Encrypt
  }
  console.log('[chat] No encryptor available, isNip07:', isNip07Login(), 'hasNip44:', !!window.nostr?.nip44)
  return null
}

// Get decryptor (Uint8Array or DecryptFunction) for listen()
function getDecryptor(): Uint8Array | DecryptFunction | null {
  const privkeyBytes = getPrivkeyBytesOrNull()
  if (privkeyBytes) {
    console.log('[chat] Using local private key for decryption')
    return privkeyBytes
  }
  const nip07Decrypt = getNip07Decrypt()
  if (nip07Decrypt) {
    console.log('[chat] Using NIP-07 nip44 for decryption')
    return nip07Decrypt
  }
  console.log('[chat] No decryptor available, isNip07:', isNip07Login(), 'hasNip44:', !!window.nostr?.nip44)
  return null
}
import {
  saveSession as saveSessionToDb,
  getAllSessions,
  saveMessage as saveMessageToDb,
  getMessagesForSession,
  serializeSessionState,
  deserializeSessionState,
  clearAllData,
  deleteSession as deleteSessionFromDb,
  deleteMessagesForSession,
  deleteMessage as deleteMessageFromDb,
  saveInvite as saveInviteToDb,
  getAllInvites,
  deleteInvite as deleteInviteFromDb,
  updateInviteLabel as updateInviteLabelInDb,
  addInviteUsedBy as addInviteUsedByInDb,
  updateMessageStatus as updateMessageStatusInDb,
  saveProcessedEvent,
  type StoredSession,
  type StoredMessage,
  type StoredInvite
} from './storage'
import { updateDMSubscription } from './notifications'
import { handleGroupEvent } from './groups'
import { shouldAdvanceStatus, type ReceiptPayload, type MessageStatus } from './receipts'
import { receiptSettings } from './receiptSettings'
import { typingSettings } from './typingSettings'
import { setRemoteTyping, clearRemoteTyping, TYPING_EXPIRY_MS } from './typingState'

export interface ChatMessage {
  id: string
  content: string
  timestamp: number
  isMine: boolean
  replyTo?: string  // ID of the message being replied to
  reactions?: Record<string, string[]>  // emoji -> array of pubkeys who reacted
  status?: MessageStatus
  senderPubkey?: string  // pubkey of sender (for group messages)
}

export interface ChatSession {
  id: string
  recipientPubkey: string
  mode: 'legacy' | 'manager'
  session?: Session
  messages: ChatMessage[]
  invite?: Invite
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

// Create a nostr subscribe function using NDK
function createNostrSubscribe(): NostrSubscribe {
  const ndkInstance = get(ndk)

  return (filter, callback) => {
    const seenIds = new Set<string>()
    const sub = ndkInstance.subscribe(filter, { closeOnEose: false })

    sub.on('event', (ndkEvent) => {
      const event = ndkEvent.rawEvent() as Parameters<typeof callback>[0]
      if (seenIds.has(event.id)) return
      seenIds.add(event.id)
      callback(event)
    })

    return () => sub.stop()
  }
}

let sessionManagerSubscribed = false
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

export function initSessionManagerEvents(): void {
  if (sessionManagerSubscribed) return
  const manager = getSessionManager()
  if (!manager) return
  sessionManagerSubscribed = true
  manager.onEvent((rumor, from) => {
    handleManagerEvent(rumor, from).catch((e) =>
      console.error('[chat] Failed to handle SessionManager event:', e)
    )
  })
  if (!sessionManagerPoller) {
    sessionManagerPoller = setInterval(() => syncManagerChats(manager), 500)
    syncManagerChats(manager)
  }
}

function syncManagerChats(manager: SessionManager): void {
  const myPubkey = getPubkey()
  if (!myPubkey) return

  const currentChats = get(chats)
  for (const [pubkey, record] of manager.getUserRecords()) {
    if (pubkey === myPubkey) continue
    if (currentChats.has(pubkey)) continue

    const hasSession = Array.from(record.devices.values()).some((device) =>
      Boolean(device.activeSession) || device.inactiveSessions.length > 0
    )
    if (!hasSession) continue

    ensureManagerChat(pubkey).catch((e) =>
      console.error('[chat] Failed to sync manager chat:', e)
    )
  }
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
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw) return null

  const parseInvitePayload = (payload: string): { purpose?: string; owner?: string } | null => {
    try {
      const decoded = decodeURIComponent(payload)
      const data = JSON.parse(decoded) as Record<string, unknown>
      if (!data || typeof data !== 'object') return null
      return {
        purpose: typeof data.purpose === 'string' ? data.purpose : undefined,
        owner: typeof data.owner === 'string' ? data.owner : undefined,
      }
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
  try {
    const url = `${getInviteBaseUrl()}#${raw}`
    const invite = Invite.fromUrl(url)
    const payload = parseInvitePayload(raw)
    if (payload?.purpose) {
      ;(invite as Invite & { purpose?: string }).purpose = payload.purpose
    }
    if (payload?.owner) {
      ;(invite as Invite & { ownerPubkey?: string }).ownerPubkey = payload.owner
    }
    return { type: 'legacy', invite }
  } catch {
    return null
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
  console.log('[chat] parseInviteFromUrl input:', url)
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
  console.log('[chat] setInviteAcceptedCallback called')
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
  console.log('[chat] loadAndMonitorInvites called, initialized:', invitesInitialized, 'isNip07:', isNip07Login())
  if (invitesInitialized) {
    console.log('[chat] Already initialized, skipping')
    return
  }

  try {
    const storedInvites = await getAllInvites()
    console.log('[chat] Found', storedInvites.length, 'stored invites to monitor')

    for (const stored of storedInvites) {
      try {
        const invite = deserializeInvite(stored.inviteData)
        const inviteId = stored.id
        const inviteLabel = stored.label

        console.log('[chat] Setting up listener for invite:', inviteId, inviteLabel)

        let unsubscribe = () => {}
        if (invite.type === 'legacy') {
          const decryptor = getDecryptor()
          if (!decryptor) {
            console.error('[chat] Cannot load legacy invites - no decryptor available')
          } else {
            // Start listening for acceptance
            unsubscribe = listenForInviteAcceptance(invite.invite, async (chatSession) => {
              console.log('[chat] Invite', inviteId, 'accepted, calling callback')
              // Track who used this invite
              await addInviteUsedByInDb(inviteId, chatSession.recipientPubkey)

              // Update invites store with the new usedBy
              invites.update(i => {
                const current = i.get(inviteId)
                if (current) {
                  const usedBy = current.usedBy || []
                  if (!usedBy.includes(chatSession.recipientPubkey)) {
                    i.set(inviteId, { ...current, usedBy: [...usedBy, chatSession.recipientPubkey] })
                  }
                }
                return i
              })

              // Store invite info in chat session
              chatSession.inviteId = inviteId
              chatSession.inviteLabel = inviteLabel

              // Update notification subscription
              updateDMSubscription()

              // Trigger navigation callback
              if (inviteAcceptedCallback) {
                inviteAcceptedCallback(chatSession)
              }
            })
          }
        }

        console.log('[chat] Listener set up for invite:', inviteId)

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

    console.log('[chat] All invites loaded and monitored')
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

async function ensureManagerChat(recipientPubkey: string): Promise<ChatSession> {
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

  return chatSession
}

export async function handleManagerEvent(rumor: Rumor, fromPubkey: string): Promise<void> {
  const myPubkey = getPubkey()
  if (!myPubkey) return

  const groupTag = rumor.tags?.find((t: string[]) => t[0] === 'l')
  if (groupTag) {
    handleGroupEvent(rumor, fromPubkey)
    return
  }

  let chatId = fromPubkey

  if (fromPubkey === myPubkey) {
    const pTag = rumor.tags?.find((t: string[]) => t[0] === 'p')
    if (pTag && pTag[1] && pTag[1] !== myPubkey) {
      chatId = pTag[1]
    } else {
      // Self-message (p-tag is us or missing): route to self chat
      chatId = myPubkey
    }
  }

  const existing = get(chats).get(chatId)
  const chatSession = await ensureManagerChat(chatId)

  const shouldAutoOpen =
    fromPubkey !== myPubkey &&
    rumor.kind === CHAT_MESSAGE_KIND &&
    (!existing || existing.messages.length === 0)

  if (shouldAutoOpen) {
    triggerAutoOpen(chatSession)
  }
  handleIncomingRumor(chatSession, rumor, undefined)
}

// Accept an invite and create a session
export async function acceptInvite(invite: ChatInvite): Promise<ChatSession> {
  if (invite.type === 'pubkey') {
    const existing = get(chats).get(invite.pubkey)
    const chatSession = await ensureManagerChat(invite.pubkey)
    if (!existing) {
      await ensureDeviceRegistered().catch(() => {})
    }
    return chatSession
  }

  const pubkey = getPubkey()
  if (!pubkey) {
    throw new Error('Not logged in')
  }

  const encryptor = getEncryptor()
  if (!encryptor) {
    // Provide more specific error for NIP-07 users without nip44 support
    if (isNip07Login()) {
      if (!window.nostr?.nip44) {
        throw new Error('Your extension does not support NIP-44 encryption')
      }
      throw new Error('Encryption not available')
    }
    throw new Error('Not logged in')
  }

  const nostrSubscribe = createNostrSubscribe()

  // Debug: log invite values before accept
  console.log('[chat] acceptInvite - invite values:', {
    inviter: invite.invite.inviter,
    inviterEphemeralPublicKey: invite.invite.inviterEphemeralPublicKey,
    sharedSecret: invite.invite.sharedSecret,
    inviterEphemeralPublicKeyLength: invite.invite.inviterEphemeralPublicKey?.length,
    inviterEphemeralPublicKeyValid: /^[0-9a-f]{64}$/i.test(invite.invite.inviterEphemeralPublicKey || ''),
  })

  const manager = getSessionManager()
  const deviceId = manager?.getDeviceId?.() || pubkey

  const { session, event } = await invite.invite.accept(
    nostrSubscribe,
    deviceId,
    encryptor,
    pubkey
  )

  const chatSession: ChatSession = {
    id: invite.invite.inviter,
    recipientPubkey: invite.invite.inviter,
    mode: 'legacy',
    session,
    messages: [],
  }

  // Subscribe to incoming messages
  subscribeToSession(chatSession)

  // Add to chats store immediately so UI updates
  chats.update(c => {
    c.set(chatSession.id, chatSession)
    return c
  })

  // Do the rest in the background to not block UI
  // Publish the accept event using NDKEvent
  const ndkInstance = get(ndk)
  const ndkPublishEvent = new NDKEvent(ndkInstance, event)
  ndkPublishEvent.publish().catch(e => console.error('[chat] Failed to publish accept event:', e))

  // Save to IndexedDB
  saveSessionToStorage(chatSession).catch(e => console.error('[chat] Failed to save session:', e))

  // Update notification subscription for new session
  updateDMSubscription()

  return chatSession
}

// Listen for invite acceptance and create session
export function listenForInviteAcceptance(invite: Invite, onSession: (session: ChatSession) => void): () => void {
  console.log('[chat] listenForInviteAcceptance called')
  const decryptor = getDecryptor()
  if (!decryptor) {
    console.error('[chat] No decryptor available for invite listening')
    // Provide more specific error for NIP-07 users without nip44 support
    if (isNip07Login()) {
      if (!window.nostr?.nip44) {
        throw new Error('Your extension does not support NIP-44 encryption')
      }
      throw new Error('Decryption not available')
    }
    throw new Error('Not logged in')
  }

  const nostrSubscribe = createNostrSubscribe()

  console.log('[chat] Starting invite listener for ephemeral key:', invite.inviterEphemeralPublicKey)
  console.log('[chat] Decryptor type:', typeof decryptor === 'function' ? 'DecryptFunction' : 'Uint8Array')
  console.log('[chat] Invite has inviterEphemeralPublicKey:', !!invite.inviterEphemeralPublicKey)
  console.log('[chat] Invite has inviterEphemeralPrivateKey:', !!invite.inviterEphemeralPrivateKey)

  return invite.listen(decryptor, nostrSubscribe, (session, identity) => {
    console.log('[chat] >>> INVITE CALLBACK FIRED! Session created for:', identity)

    // Check if we already have a session with this identity (e.g., loaded from storage)
    const existingChats = get(chats)
    if (existingChats.has(identity)) {
      console.log('[chat] Session already exists for', identity, '- skipping')
      return  // Session already exists, don't overwrite
    }

    const chatSession: ChatSession = {
      id: identity,
      recipientPubkey: identity,
      mode: 'legacy',
      session,
      messages: [],
      invite,
    }

    // Subscribe to incoming messages
    subscribeToSession(chatSession)

    // Add to chats store
    chats.update(c => {
      c.set(chatSession.id, chatSession)
      return c
    })

    // Save to IndexedDB
    saveSessionToStorage(chatSession)

    // Update notification subscription for new session
    updateDMSubscription()

    onSession(chatSession)
  })
}

function handleIncomingRumor(chatSession: ChatSession, rumor: Rumor, outerEvent?: OuterEvent) {
  const myPubkey = getPubkey()
  const sessionId = chatSession.id

  // Get current state from store (not the captured reference which may be stale)
  const currentChats = get(chats)
  const currentSession = currentChats.get(sessionId)
  if (!currentSession) return

  // Route group events to group handler
  const groupTag = rumor.tags?.find((t: string[]) => t[0] === 'l')
  if (groupTag) {
    handleGroupEvent(rumor, chatSession.recipientPubkey, outerEvent)
    if (currentSession.mode === 'legacy') {
      saveSessionToStorage(currentSession)
    }
    return
  }

  const processedId = outerEvent?.id || rumor.id

  // Dispatch on inner event kind
  if (rumor.kind === RECEIPT_KIND) {
    saveProcessedEvent({ id: processedId, kind: rumor.kind, chatId: sessionId, timestamp: Date.now() })
    const type = rumor.content as 'delivered' | 'seen'
    if (type !== 'delivered' && type !== 'seen') return
    const messageIds = rumor.tags
      ?.filter((t: string[]) => t[0] === 'e')
      .map((t: string[]) => t[1]) || []
    if (messageIds.length === 0) return
    handleIncomingReceipt(currentSession, { type, messageIds })
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

  if (rumor.kind === TYPING_KIND) {
    saveProcessedEvent({ id: processedId, kind: rumor.kind, chatId: sessionId, timestamp: Date.now() })
    const ageMs = Date.now() - rumor.created_at * 1000
    if (ageMs < TYPING_EXPIRY_MS) {
      setRemoteTyping(sessionId, rumor.created_at)
    }
    return
  }

  // Incoming message clears typing indicator
  clearRemoteTyping(sessionId, rumor.created_at)

  // Extract reply tag if present
  const replyTag = rumor.tags?.find(
    (tag: string[]) => tag[0] === 'e' && tag[3] === 'reply'
  )?.[1] || rumor.tags?.find(
    (tag: string[]) => tag[0] === 'e' && !rumor.tags?.some((t: string[]) => t[0] === 'e' && t[3] === 'root')
  )?.[1]

  const isMine = rumor.pubkey === myPubkey

  // Auto-set delivered status for incoming messages
  const shouldAckDelivered = !isMine && get(receiptSettings).sendDeliveryReceipts

  const message: ChatMessage = {
    id: processedId,
    content: rumor.content,
    timestamp: rumor.created_at * 1000,
    isMine,
    ...(replyTag && { replyTo: replyTag }),
    ...(shouldAckDelivered && { status: 'delivered' as const }),
  }

  // Check if message already exists
  if (currentSession.messages.some((m) => m.id === message.id)) return

  const updatedMessages = [...currentSession.messages, message].sort((a, b) => a.timestamp - b.timestamp)
  const updatedSession = { ...currentSession, messages: updatedMessages }

  // Update store
  chats.update((c) => {
    c.set(sessionId, updatedSession)
    return c
  })

  // Update current chat if it's this one
  const current = get(currentChat)
  if (current?.id === sessionId) {
    currentChat.set(updatedSession)
  }

  // Save message and updated session state to IndexedDB
  saveMessageToStorage(sessionId, message)
  if (updatedSession.mode === 'legacy') {
    saveSessionToStorage(updatedSession)
  } else {
    saveSessionToStorage(updatedSession)
  }

  // Send delivered receipt
  if (shouldAckDelivered) {
    sendReceipt(updatedSession, 'delivered', [message.id])
  }

  // Update notification subscription (debounced) since keys may have rotated
  updateDMSubscription()
}

// Subscribe to incoming messages for a session
function subscribeToSession(chatSession: ChatSession) {
  if (!chatSession.session) return
  chatSession.session.onEvent((rumor: Rumor, outerEvent?: OuterEvent) => {
    handleIncomingRumor(chatSession, rumor, outerEvent)
  })
}

// Handle incoming reaction
function handleIncomingReaction(chatSession: ChatSession, reaction: { messageId: string, emoji: string }, fromPubkey: string) {
  const messageIndex = chatSession.messages.findIndex(m => m.id === reaction.messageId)
  if (messageIndex === -1) return

  const message = chatSession.messages[messageIndex]

  // Create updated reactions - first remove user from any existing reactions
  const reactions: Record<string, string[]> = {}
  for (const [emoji, users] of Object.entries(message.reactions || {})) {
    const filtered = users.filter(u => u !== fromPubkey)
    if (filtered.length > 0) {
      reactions[emoji] = filtered
    }
  }

  // Add user to new reaction
  if (!reactions[reaction.emoji]) {
    reactions[reaction.emoji] = []
  }
  reactions[reaction.emoji] = [...reactions[reaction.emoji], fromPubkey]

  // Create new message with reactions
  const updatedMessage = { ...message, reactions }

  // Create new messages array for reactivity
  const updatedMessages = [...chatSession.messages]
  updatedMessages[messageIndex] = updatedMessage
  chatSession.messages = updatedMessages

  // Update store
  chats.update(c => {
    c.set(chatSession.id, { ...chatSession, messages: updatedMessages })
    return c
  })

  // Update current chat if it's this one
  const current = get(currentChat)
  if (current?.id === chatSession.id) {
    currentChat.set({ ...chatSession, messages: updatedMessages })
  }

  // Save updated message to IndexedDB
  saveMessageToStorage(chatSession.id, updatedMessage)
  saveSessionToStorage(chatSession)
}

// Handle incoming receipt - updates status on own messages
function handleIncomingReceipt(chatSession: ChatSession, receipt: ReceiptPayload) {
  let changed = false
  const updatedMessages = [...chatSession.messages]

  for (const messageId of receipt.messageIds) {
    const index = updatedMessages.findIndex(m => m.id === messageId && m.isMine)
    if (index === -1) continue

    const message = updatedMessages[index]
    if (!shouldAdvanceStatus(message.status, receipt.type)) continue

    updatedMessages[index] = { ...message, status: receipt.type }
    changed = true

    // Persist to IndexedDB
    updateMessageStatusInDb(messageId, receipt.type)
  }

  if (!changed) return

  // Update store
  chats.update(c => {
    c.set(chatSession.id, { ...chatSession, messages: updatedMessages })
    return c
  })

  // Update current chat if it's this one
  const current = get(currentChat)
  if (current?.id === chatSession.id) {
    currentChat.set({ ...chatSession, messages: updatedMessages })
  }
}

function buildManagerRumor(recipientPubkey: string, partial: Partial<Rumor>): Rumor {
  const myPubkey = getPubkey()
  if (!myPubkey) {
    throw new Error('Not logged in')
  }

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

  if (chatSession.mode === 'manager') {
    const manager = getSessionManager()
    if (!manager) return
    const rumor = buildManagerRumor(chatSession.recipientPubkey, {
      content: type,
      kind: RECEIPT_KIND,
      tags: messageIds.map((id) => ['e', id]),
    })
    manager.sendEvent(chatSession.recipientPubkey, rumor).catch(() => {})
    return
  }

  if (!chatSession.session) return
  const { event } = chatSession.session.sendReceipt(type, messageIds)

  const ndkInstance = get(ndk)
  const ndkPublishEvent = new NDKEvent(ndkInstance, event)
  ndkPublishEvent.publish().catch(e => console.error('[chat] Failed to publish receipt:', e))

  // Save session state since keys may have rotated
  saveSessionToStorage(chatSession)
}

// Send seen receipts for incoming messages - called from ChatView
export function sendSeenReceipts(chatSession: ChatSession, messageIds: string[]): void {
  if (!get(receiptSettings).sendReadReceipts) return

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

  // Update status on messages
  const updatedMessages = currentSession.messages.map(m => {
    if (toAck.includes(m.id)) {
      const updated = { ...m, status: 'seen' as const }
      updateMessageStatusInDb(m.id, 'seen')
      return updated
    }
    return m
  })

  const updatedSession = { ...currentSession, messages: updatedMessages }
  chats.update(c => {
    c.set(chatSession.id, updatedSession)
    return c
  })

  const current = get(currentChat)
  if (current?.id === chatSession.id) {
    currentChat.set(updatedSession)
  }

  sendReceipt(updatedSession, 'seen', toAck)
}

// Send a message
export function sendMessage(chatSession: ChatSession, text: string, replyTo?: string): void {
  const tags: string[][] = []
  if (replyTo) {
    tags.push(['e', replyTo, '', 'reply'])
  }

  let messageId = ''
  let publishEvent: NDKEvent | null = null

  if (chatSession.mode === 'manager') {
    const manager = getSessionManager()
    if (!manager) return
    const rumor = buildManagerRumor(chatSession.recipientPubkey, {
      content: text,
      kind: CHAT_MESSAGE_KIND,
      tags,
    })
    messageId = rumor.id
    manager.sendEvent(chatSession.recipientPubkey, rumor).catch(() => {})
  } else {
    if (!chatSession.session) return
    const { event } = tags.length > 0
      ? chatSession.session.sendEvent({ content: text, kind: CHAT_MESSAGE_KIND, tags })
      : chatSession.session.send(text)
    messageId = event.id
    const ndkInstance = get(ndk)
    publishEvent = new NDKEvent(ndkInstance, event)
  }

  // Get current state from store (not the passed reference which may be stale)
  const currentChats = get(chats)
  const currentSession = currentChats.get(chatSession.id)
  if (!currentSession) return

  // Add message optimistically - use outer event ID for service worker lookup
  const message: ChatMessage = {
    id: messageId,
    content: text,
    timestamp: Date.now(),
    isMine: true,
    ...(replyTo && { replyTo }),
  }

  const updatedMessages = [...currentSession.messages, message]
  const updatedSession = { ...currentSession, messages: updatedMessages }

  // Update stores synchronously
  chats.update(c => {
    c.set(chatSession.id, updatedSession)
    return c
  })

  const current = get(currentChat)
  if (current?.id === chatSession.id) {
    currentChat.set(updatedSession)
  }

  // Save and publish in background - don't block UI
  saveMessageToStorage(chatSession.id, message)
  saveSessionToStorage(updatedSession)

  // Update notification subscription (debounced) since keys may have rotated
  updateDMSubscription()

  if (publishEvent) {
    publishEvent.publish()
  }
}

// Send a reaction to a message
export async function sendReaction(chatSession: ChatSession, messageId: string, emoji: string): Promise<void> {
  if (chatSession.mode === 'manager') {
    const manager = getSessionManager()
    if (!manager) return
    const rumor = buildManagerRumor(chatSession.recipientPubkey, {
      content: emoji,
      kind: REACTION_KIND,
      tags: [['e', messageId]],
    })
    manager.sendEvent(chatSession.recipientPubkey, rumor).catch(() => {})
  } else {
    if (!chatSession.session) return
    const { event } = chatSession.session.sendReaction(messageId, emoji)
    const ndkInstance = get(ndk)
    const ndkPublishEvent = new NDKEvent(ndkInstance, event)
    await ndkPublishEvent.publish()
  }

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

    // Update stores
    const updatedSession = { ...currentSession, messages: updatedMessages }
    chats.update(c => {
      c.set(chatSession.id, updatedSession)
      return c
    })

    const current = get(currentChat)
    if (current?.id === chatSession.id) {
      currentChat.set(updatedSession)
    }
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

  // Filter out the message
  const updatedMessages = currentSession.messages.filter(m => m.id !== messageId)
  const updatedSession = { ...currentSession, messages: updatedMessages }

  // Update stores
  chats.update(c => {
    c.set(sessionId, updatedSession)
    return c
  })

  const current = get(currentChat)
  if (current?.id === sessionId) {
    currentChat.set(updatedSession)
  }

  // Delete from IndexedDB
  await deleteMessageFromDb(messageId)
}

// Leave current chat
export function leaveChat(): void {
  const current = get(currentChat)
  if (current) {
    current.session?.close()
  }
  currentChat.set(null)
  // Clear URL hash
  history.replaceState(null, '', window.location.pathname)
}

// Delete a chat completely
export function deleteChat(chatSession: ChatSession): void {
  // Close the session
  if (chatSession.mode === 'legacy') {
    chatSession.session?.close()
  } else {
    const manager = getSessionManager()
    manager?.deleteUser(chatSession.recipientPubkey).catch(() => {})
  }

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
      sessionState: chatSession.mode === 'legacy' && chatSession.session
        ? serializeSessionState(chatSession.session.state)
        : undefined,
      createdAt: Date.now(),
      inviteId: chatSession.inviteId,
      inviteLabel: chatSession.inviteLabel,
      mode: chatSession.mode,
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
      ...(message.senderPubkey && { senderPubkey: message.senderPubkey })
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
    const nostrSubscribe = createNostrSubscribe()
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
            senderPubkey: m.senderPubkey
          }))
          .sort((a, b) => a.timestamp - b.timestamp)

        let chatSession: ChatSession
        if (stored.sessionState) {
          // Deserialize the session state
          const sessionState = deserializeSessionState(stored.sessionState)
          const session = new Session(nostrSubscribe, sessionState as never)

          chatSession = {
            id: stored.id,
            recipientPubkey: stored.recipientPubkey,
            mode: 'legacy',
            session,
            messages,
            inviteId: stored.inviteId,
            inviteLabel: stored.inviteLabel,
          }

          // Subscribe to incoming messages
          subscribeToSession(chatSession)
        } else {
          chatSession = {
            id: stored.id,
            recipientPubkey: stored.recipientPubkey,
            mode: stored.mode === 'legacy' ? 'legacy' : 'manager',
            messages,
            inviteId: stored.inviteId,
            inviteLabel: stored.inviteLabel,
          }
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

    isInitialized = true
  } catch (e) {
    console.error('Failed to load chats from storage:', e)
  }
}

// Send a typing indicator event
export function sendTypingEvent(chatSession: ChatSession): void {
  if (!get(typingSettings).sendTypingIndicators) return

  if (chatSession.mode === 'manager') {
    const manager = getSessionManager()
    if (!manager) return
    const rumor = buildManagerRumor(chatSession.recipientPubkey, {
      content: 'typing',
      kind: TYPING_KIND,
      tags: [],
    })
    manager.sendEvent(chatSession.recipientPubkey, rumor).catch(() => {})
    return
  }

  if (!chatSession.session) return
  const { event } = chatSession.session.sendTyping()

  const ndkInstance = get(ndk)
  const ndkPublishEvent = new NDKEvent(ndkInstance, event)
  ndkPublishEvent.publish().catch(e => console.error('[chat] Failed to publish typing event:', e))

  saveSessionToStorage(chatSession)
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

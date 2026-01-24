import { writable, get } from 'svelte/store'
import { Invite, Session, type Rumor } from 'nostr-double-ratchet'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import type { VerifiedEvent, Filter } from 'nostr-tools'
import { ndk, getPrivkeyBytes, getPubkey, isNip07Login } from './identity'
import type { EncryptFunction, DecryptFunction } from 'nostr-double-ratchet'

// Type for encryptor/decryptor - either raw key bytes or encrypt/decrypt functions
type Encryptor = Uint8Array | { encrypt: EncryptFunction; decrypt: DecryptFunction }

// Get encryptor that works for both local key and NIP-07
function getEncryptor(): Encryptor | null {
  // Try local private key first
  const privkeyBytes = getPrivkeyBytes()
  if (privkeyBytes) {
    return privkeyBytes
  }

  // For NIP-07, use the extension's nip44 encrypt/decrypt functions
  if (isNip07Login() && window.nostr?.nip44) {
    return {
      encrypt: async (plaintext: string, pubkey: string) => {
        return window.nostr!.nip44!.encrypt(pubkey, plaintext)
      },
      decrypt: async (ciphertext: string, pubkey: string) => {
        return window.nostr!.nip44!.decrypt(pubkey, ciphertext)
      }
    }
  }

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
  saveInvite as saveInviteToDb,
  getAllInvites,
  deleteInvite as deleteInviteFromDb,
  updateInviteLabel as updateInviteLabelInDb,
  addInviteUsedBy as addInviteUsedByInDb,
  type StoredSession,
  type StoredMessage,
  type StoredInvite
} from './storage'
import { updateDMSubscription } from './notifications'

export interface ChatMessage {
  id: string
  content: string
  timestamp: number
  isMine: boolean
  reactions?: Record<string, string[]>  // emoji -> array of pubkeys who reacted
}

export interface ChatSession {
  id: string
  recipientPubkey: string
  session: Session
  messages: ChatMessage[]
  invite?: Invite
  inviteId?: string      // ID of the invite that started this chat
  inviteLabel?: string   // Label of the invite that started this chat
}

export interface ActiveInvite {
  id: string
  invite: Invite
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

// Create a nostr subscribe function using NDK
function createNostrSubscribe() {
  const ndkInstance = get(ndk)

  return (filter: Filter, callback: (event: VerifiedEvent) => void) => {
    const seenIds = new Set<string>()
    const sub = ndkInstance.subscribe(filter, { closeOnEose: false })

    sub.on('event', (ndkEvent) => {
      const event = ndkEvent.rawEvent() as VerifiedEvent
      if (seenIds.has(event.id)) return
      seenIds.add(event.id)
      callback(event)
    })

    return () => {
      sub.stop()
    }
  }
}

// Create a new invite that can be shared
export function createInvite(): Invite {
  const pubkey = getPubkey()
  if (!pubkey) throw new Error('Not logged in')

  return Invite.createNew(pubkey)
}

// Get invite URL
export function getInviteUrl(invite: Invite): string {
  return invite.getUrl(window.location.origin)
}

// Parse invite from URL hash
export function parseInviteFromHash(): Invite | null {
  const hash = window.location.hash
  if (!hash || hash.length < 2) return null

  try {
    const url = window.location.href
    return Invite.fromUrl(url)
  } catch {
    return null
  }
}

// Parse invite from a pasted URL
export function parseInviteFromUrl(url: string): Invite | null {
  try {
    return Invite.fromUrl(url)
  } catch {
    return null
  }
}

// Serialize invite for storage
export function serializeInvite(invite: Invite): string {
  return invite.serialize()
}

// Deserialize invite from storage
export function deserializeInvite(data: string): Invite {
  return Invite.deserialize(data)
}

// Callback for when an invite is accepted
let inviteAcceptedCallback: ((session: ChatSession) => void) | null = null

// Set callback for invite acceptance (called from App.svelte)
export function setInviteAcceptedCallback(callback: (session: ChatSession) => void): void {
  inviteAcceptedCallback = callback
}

// Create a new invite and save to storage
export async function createAndSaveInvite(label?: string): Promise<ActiveInvite> {
  const pubkey = getPubkey()
  if (!pubkey) throw new Error('Not logged in')

  const invite = Invite.createNew(pubkey)
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

  // Start listening for acceptance
  const currentLabel = label
  const unsubscribe = listenForInviteAcceptance(invite, async (chatSession) => {
    // Track who used this invite
    await addInviteUsedByInDb(id, chatSession.recipientPubkey)

    // Update invites store with the new usedBy
    invites.update(i => {
      const current = i.get(id)
      if (current) {
        const usedBy = current.usedBy || []
        if (!usedBy.includes(chatSession.recipientPubkey)) {
          i.set(id, { ...current, usedBy: [...usedBy, chatSession.recipientPubkey] })
        }
      }
      return i
    })

    // Store invite info in chat session
    chatSession.inviteId = id
    chatSession.inviteLabel = currentLabel

    // Update notification subscription
    updateDMSubscription()

    // Trigger navigation callback
    if (inviteAcceptedCallback) {
      inviteAcceptedCallback(chatSession)
    }
  })

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
  if (invitesInitialized) return

  try {
    const storedInvites = await getAllInvites()

    for (const stored of storedInvites) {
      try {
        const invite = deserializeInvite(stored.inviteData)
        const inviteId = stored.id
        const inviteLabel = stored.label

        // Start listening for acceptance
        const unsubscribe = listenForInviteAcceptance(invite, async (chatSession) => {
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
        console.error('Failed to restore invite:', stored.id, e)
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
    // Get the ephemeral pubkey from the invite that responses will be sent to
    if (activeInvite.invite.inviterEphemeralPublicKey) {
      pubkeys.push(activeInvite.invite.inviterEphemeralPublicKey)
    }
  }

  return pubkeys
}

// Accept an invite and create a session
export async function acceptInvite(invite: Invite): Promise<ChatSession> {
  const pubkey = getPubkey()
  const encryptor = getEncryptor()

  if (!pubkey || !encryptor) {
    throw new Error('Not logged in')
  }

  const nostrSubscribe = createNostrSubscribe()
  const { session, event } = await invite.accept(nostrSubscribe, pubkey, encryptor)

  // Publish the accept event using NDKEvent
  const ndkInstance = get(ndk)
  const ndkPublishEvent = new NDKEvent(ndkInstance, event)
  await ndkPublishEvent.publish()

  const chatSession: ChatSession = {
    id: invite.inviter,
    recipientPubkey: invite.inviter,
    session,
    messages: [],
  }

  // Subscribe to incoming messages
  subscribeToSession(chatSession)

  // Add to chats store
  chats.update(c => {
    c.set(chatSession.id, chatSession)
    return c
  })

  // Save to IndexedDB
  await saveSessionToStorage(chatSession)

  // Update notification subscription for new session
  updateDMSubscription()

  return chatSession
}

// Listen for invite acceptance and create session
export function listenForInviteAcceptance(invite: Invite, onSession: (session: ChatSession) => void): () => void {
  const encryptor = getEncryptor()
  if (!encryptor) {
    throw new Error('Not logged in or NIP-44 not available')
  }

  const nostrSubscribe = createNostrSubscribe()

  return invite.listen(encryptor, nostrSubscribe, (session, identity) => {
    // Check if we already have a session with this identity (e.g., loaded from storage)
    const existingChats = get(chats)
    if (existingChats.has(identity)) {
      return  // Session already exists, don't overwrite
    }

    const chatSession: ChatSession = {
      id: identity,
      recipientPubkey: identity,
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

// Reaction message format
interface ReactionPayload {
  type: 'reaction'
  messageId: string
  emoji: string
}

function isReactionPayload(content: string): ReactionPayload | null {
  try {
    const parsed = JSON.parse(content)
    if (parsed.type === 'reaction' && parsed.messageId && parsed.emoji) {
      return parsed as ReactionPayload
    }
  } catch {
    // Not JSON, regular message
  }
  return null
}

// Subscribe to incoming messages for a session
function subscribeToSession(chatSession: ChatSession) {
  const myPubkey = getPubkey()
  const sessionId = chatSession.id

  chatSession.session.onEvent((rumor: Rumor, outerEvent?: VerifiedEvent) => {
    // Get current state from store (not the captured reference which may be stale)
    const currentChats = get(chats)
    const currentSession = currentChats.get(sessionId)
    if (!currentSession) return

    // Check if this is a reaction
    const reactionPayload = isReactionPayload(rumor.content)
    if (reactionPayload) {
      handleIncomingReaction(currentSession, reactionPayload, rumor.pubkey)
      return
    }

    // Use outer event ID for message ID - allows service worker to look up by push event ID
    const message: ChatMessage = {
      id: outerEvent?.id || rumor.id,
      content: rumor.content,
      timestamp: rumor.created_at * 1000,
      isMine: rumor.pubkey === myPubkey,
    }

    // Check if message already exists
    if (currentSession.messages.some(m => m.id === message.id)) return

    const updatedMessages = [...currentSession.messages, message].sort((a, b) => a.timestamp - b.timestamp)
    const updatedSession = { ...currentSession, messages: updatedMessages }

    // Update store
    chats.update(c => {
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
    saveSessionToStorage(updatedSession)

    // Update notification subscription (debounced) since keys may have rotated
    updateDMSubscription()
  })
}

// Handle incoming reaction
function handleIncomingReaction(chatSession: ChatSession, reaction: ReactionPayload, fromPubkey: string) {
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

// Send a message
export function sendMessage(chatSession: ChatSession, text: string): void {
  const { event } = chatSession.session.send(text)

  // Get current state from store (not the passed reference which may be stale)
  const currentChats = get(chats)
  const currentSession = currentChats.get(chatSession.id)
  if (!currentSession) return

  // Add message optimistically - use outer event ID for service worker lookup
  const message: ChatMessage = {
    id: event.id,
    content: text,
    timestamp: Date.now(),
    isMine: true,
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

  const ndkInstance = get(ndk)
  const ndkPublishEvent = new NDKEvent(ndkInstance, event)
  ndkPublishEvent.publish()
}

// Send a reaction to a message
export async function sendReaction(chatSession: ChatSession, messageId: string, emoji: string): Promise<void> {
  const payload: ReactionPayload = {
    type: 'reaction',
    messageId,
    emoji
  }

  const { event } = chatSession.session.send(JSON.stringify(payload))

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

  // Publish the encrypted event
  const ndkInstance = get(ndk)
  const ndkPublishEvent = new NDKEvent(ndkInstance, event)
  await ndkPublishEvent.publish()
}

// Leave current chat
export function leaveChat(): void {
  const current = get(currentChat)
  if (current) {
    current.session.close()
  }
  currentChat.set(null)
  // Clear URL hash
  history.replaceState(null, '', window.location.pathname)
}

// Delete a chat completely
export function deleteChat(chatSession: ChatSession): void {
  // Close the session
  chatSession.session.close()

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
async function saveSessionToStorage(chatSession: ChatSession): Promise<void> {
  try {
    const storedSession: StoredSession = {
      id: chatSession.id,
      recipientPubkey: chatSession.recipientPubkey,
      sessionState: serializeSessionState(chatSession.session.state),
      createdAt: Date.now(),
      inviteId: chatSession.inviteId,
      inviteLabel: chatSession.inviteLabel
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
      reactions
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

    for (const stored of storedSessions) {
      try {
        // Deserialize the session state
        const sessionState = deserializeSessionState(stored.sessionState)

        // Create a new Session with the restored state
        const session = new Session(nostrSubscribe, sessionState as never)

        // Load messages for this session
        const storedMessages = await getMessagesForSession(stored.id)
        const messages: ChatMessage[] = storedMessages
          .map(m => ({
            id: m.id,
            content: m.content,
            timestamp: m.timestamp,
            isMine: m.isMine,
            reactions: m.reactions
          }))
          .sort((a, b) => a.timestamp - b.timestamp)

        const chatSession: ChatSession = {
          id: stored.id,
          recipientPubkey: stored.recipientPubkey,
          session,
          messages,
          inviteId: stored.inviteId,
          inviteLabel: stored.inviteLabel
        }

        // Subscribe to incoming messages
        subscribeToSession(chatSession)

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
  } catch (e) {
    console.error('Failed to clear chat data:', e)
  }
}

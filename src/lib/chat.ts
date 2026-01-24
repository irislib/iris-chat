import { writable, get } from 'svelte/store'
import { Invite, Session, type Rumor } from 'nostr-double-ratchet'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import type { VerifiedEvent, Filter } from 'nostr-tools'
import { ndk, getPrivkeyBytes, getPubkey } from './identity'
import {
  initDB,
  saveSession as saveSessionToDb,
  getAllSessions,
  saveMessage as saveMessageToDb,
  getMessagesForSession,
  serializeSessionState,
  deserializeSessionState,
  clearAllData,
  type StoredSession,
  type StoredMessage
} from './storage'

export interface ChatMessage {
  id: string
  content: string
  timestamp: number
  isMine: boolean
}

export interface ChatSession {
  id: string
  recipientPubkey: string
  session: Session
  messages: ChatMessage[]
  invite?: Invite
}

export const chats = writable<Map<string, ChatSession>>(new Map())
export const currentChat = writable<ChatSession | null>(null)
let isInitialized = false

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

// Accept an invite and create a session
export async function acceptInvite(invite: Invite): Promise<ChatSession> {
  const pubkey = getPubkey()
  const privkeyBytes = getPrivkeyBytes()

  if (!pubkey || !privkeyBytes) {
    throw new Error('Not logged in')
  }

  const nostrSubscribe = createNostrSubscribe()
  const { session, event } = await invite.accept(nostrSubscribe, pubkey, privkeyBytes)

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

  return chatSession
}

// Listen for invite acceptance and create session
export function listenForInviteAcceptance(invite: Invite, onSession: (session: ChatSession) => void): () => void {
  const privkeyBytes = getPrivkeyBytes()
  if (!privkeyBytes) {
    throw new Error('Not logged in')
  }

  const nostrSubscribe = createNostrSubscribe()

  return invite.listen(privkeyBytes, nostrSubscribe, (session, identity) => {
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
    onSession(chatSession)
  })
}

// Subscribe to incoming messages for a session
function subscribeToSession(chatSession: ChatSession) {
  const myPubkey = getPubkey()

  chatSession.session.onEvent((rumor: Rumor) => {
    const message: ChatMessage = {
      id: rumor.id,
      content: rumor.content,
      timestamp: rumor.created_at * 1000,
      isMine: rumor.pubkey === myPubkey,
    }

    // Check if message already exists
    if (chatSession.messages.some(m => m.id === message.id)) return

    chatSession.messages = [...chatSession.messages, message].sort((a, b) => a.timestamp - b.timestamp)

    // Update store
    chats.update(c => {
      c.set(chatSession.id, { ...chatSession })
      return c
    })

    // Update current chat if it's this one
    const current = get(currentChat)
    if (current?.id === chatSession.id) {
      currentChat.set({ ...chatSession })
    }

    // Save message and updated session state to IndexedDB
    saveMessageToStorage(chatSession.id, message)
    saveSessionToStorage(chatSession)
  })
}

// Send a message
export async function sendMessage(chatSession: ChatSession, text: string): Promise<void> {
  const { event, innerEvent } = chatSession.session.send(text)

  // Add message optimistically
  const message: ChatMessage = {
    id: innerEvent.id,
    content: text,
    timestamp: Date.now(),
    isMine: true,
  }

  chatSession.messages = [...chatSession.messages, message]

  // Update stores
  chats.update(c => {
    c.set(chatSession.id, { ...chatSession })
    return c
  })

  const current = get(currentChat)
  if (current?.id === chatSession.id) {
    currentChat.set({ ...chatSession })
  }

  // Save message and updated session state to IndexedDB
  await saveMessageToStorage(chatSession.id, message)
  await saveSessionToStorage(chatSession)

  // Publish the encrypted event using NDKEvent
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

// Storage helpers
async function saveSessionToStorage(chatSession: ChatSession): Promise<void> {
  try {
    const storedSession: StoredSession = {
      id: chatSession.id,
      recipientPubkey: chatSession.recipientPubkey,
      sessionState: serializeSessionState(chatSession.session.state),
      createdAt: Date.now()
    }
    await saveSessionToDb(storedSession)
  } catch (e) {
    console.error('Failed to save session to storage:', e)
  }
}

async function saveMessageToStorage(sessionId: string, message: ChatMessage): Promise<void> {
  try {
    const storedMessage: StoredMessage = {
      id: message.id,
      sessionId,
      content: message.content,
      timestamp: message.timestamp,
      isMine: message.isMine
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
    await initDB()
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
            isMine: m.isMine
          }))
          .sort((a, b) => a.timestamp - b.timestamp)

        const chatSession: ChatSession = {
          id: stored.id,
          recipientPubkey: stored.recipientPubkey,
          session,
          messages
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
    await clearAllData()
    chats.set(new Map())
    currentChat.set(null)
    isInitialized = false
  } catch (e) {
    console.error('Failed to clear chat data:', e)
  }
}

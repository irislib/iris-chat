// IndexedDB storage using Dexie

import Dexie, { type Table } from 'dexie'

// Re-export serialization functions from nostr-double-ratchet
export { serializeSessionState, deserializeSessionState } from 'nostr-double-ratchet'

export interface StoredSession {
  id: string
  recipientPubkey: string
  sessionState: string // JSON-serialized session state (hex encoded by nostr-double-ratchet)
  createdAt: number
}

export interface StoredMessage {
  id: string
  sessionId: string
  content: string
  timestamp: number
  isMine: boolean
  reactions?: Record<string, string[]>  // emoji -> array of pubkeys who reacted
}

export interface StoredProfile {
  pubkey: string
  name?: string
  display_name?: string
  picture?: string
  updatedAt: number
}

class IrisChatDB extends Dexie {
  sessions!: Table<StoredSession, string>
  messages!: Table<StoredMessage, string>
  profiles!: Table<StoredProfile, string>

  constructor() {
    super('iris-chat')
    this.version(1).stores({
      sessions: 'id',
      messages: 'id, sessionId',
      profiles: 'pubkey'
    })
  }
}

export const db = new IrisChatDB()

// Session operations
export async function saveSession(session: StoredSession): Promise<void> {
  await db.sessions.put(session)
}

export async function getAllSessions(): Promise<StoredSession[]> {
  return db.sessions.toArray()
}

export async function deleteSession(id: string): Promise<void> {
  await db.sessions.delete(id)
}

// Message operations
export async function saveMessage(message: StoredMessage): Promise<void> {
  await db.messages.put(message)
}

export async function getMessagesForSession(sessionId: string): Promise<StoredMessage[]> {
  return db.messages.where('sessionId').equals(sessionId).toArray()
}

export async function deleteMessagesForSession(sessionId: string): Promise<void> {
  await db.messages.where('sessionId').equals(sessionId).delete()
}

export async function getMessageById(id: string): Promise<StoredMessage | undefined> {
  return db.messages.get(id)
}

// Profile operations
export async function saveProfileToStorage(profile: StoredProfile): Promise<void> {
  await db.profiles.put(profile)
}

export async function getProfileFromStorage(pubkey: string): Promise<StoredProfile | undefined> {
  return db.profiles.get(pubkey)
}

// Clear all data (for logout)
export async function clearAllData(): Promise<void> {
  await Promise.all([
    db.sessions.clear(),
    db.messages.clear(),
    db.profiles.clear()
  ])
}

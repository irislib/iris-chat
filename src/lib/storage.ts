// IndexedDB storage using Dexie

import Dexie, { type Table } from 'dexie'

// Re-export serialization functions from nostr-double-ratchet
export { serializeSessionState, deserializeSessionState } from 'nostr-double-ratchet'

export interface StoredSession {
  id: string
  recipientPubkey: string
  sessionState?: string // JSON-serialized session state (hex encoded by nostr-double-ratchet)
  createdAt: number
  inviteId?: string      // ID of the invite that started this chat
  inviteLabel?: string   // Label of the invite that started this chat
  mode?: 'legacy' | 'manager'
}

export interface StoredMessage {
  id: string
  sessionId: string
  content: string
  timestamp: number
  isMine: boolean
  replyTo?: string
  reactions?: Record<string, string[]>  // emoji -> array of pubkeys who reacted
  status?: 'delivered' | 'seen'
  senderPubkey?: string  // pubkey of sender (for group messages)
  expiresAt?: number  // Unix timestamp in seconds when message expires (NIP-40)
}

export interface StoredGroup {
  id: string
  name: string
  description?: string
  picture?: string
  members: string[]  // pubkeys of group members
  admins: string[]   // pubkeys of admins
  createdAt: number
  secret?: string     // 32-byte hex group secret for shared channel
  accepted?: boolean  // whether user has accepted the group invitation
}

export interface StoredProfile {
  pubkey: string
  name?: string
  display_name?: string
  picture?: string
  updatedAt: number
}

export interface StoredInvite {
  id: string           // unique id
  inviteData: string   // serialized invite payload (legacy or pubkey link)
  label?: string       // optional user label
  createdAt: number
  usedBy?: string[]    // pubkeys of users who accepted this invite
}

export interface ProcessedEvent {
  id: string           // outer event ID
  kind: number         // inner event kind (7=reaction, 15=receipt, 25=typing)
  chatId: string       // session/chat ID
  content?: string     // e.g. emoji for reactions
  isSelfMessage?: boolean
  timestamp: number
}

export interface PendingPushEvent {
  id: string
  event: unknown
  timestamp: number
}

class IrisChatDB extends Dexie {
  sessions!: Table<StoredSession, string>
  messages!: Table<StoredMessage, string>
  profiles!: Table<StoredProfile, string>
  invites!: Table<StoredInvite, string>
  processedEvents!: Table<ProcessedEvent, string>
  groups!: Table<StoredGroup, string>
  sessionManager!: Table<{ key: string; value: unknown }, string>
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

export async function deleteMessage(id: string): Promise<void> {
  await db.messages.delete(id)
}

export async function updateMessageStatus(id: string, status: 'delivered' | 'seen'): Promise<void> {
  await db.messages.update(id, { status })
}

// Profile operations
export async function saveProfileToStorage(profile: StoredProfile): Promise<void> {
  await db.profiles.put(profile)
}

export async function getProfileFromStorage(pubkey: string): Promise<StoredProfile | undefined> {
  return db.profiles.get(pubkey)
}

// Invite operations
export async function saveInvite(invite: StoredInvite): Promise<void> {
  await db.invites.put(invite)
}

export async function getAllInvites(): Promise<StoredInvite[]> {
  return db.invites.toArray()
}

export async function deleteInvite(id: string): Promise<void> {
  await db.invites.delete(id)
}

export async function updateInviteLabel(id: string, label: string): Promise<void> {
  await db.invites.update(id, { label })
}

export async function addInviteUsedBy(id: string, pubkey: string): Promise<void> {
  const invite = await db.invites.get(id)
  if (invite) {
    const usedBy = invite.usedBy || []
    if (!usedBy.includes(pubkey)) {
      await db.invites.update(id, { usedBy: [...usedBy, pubkey] })
    }
  }
}

// Processed event operations (for SW notification suppression)
export async function saveProcessedEvent(event: ProcessedEvent): Promise<void> {
  await db.processedEvents.put(event)
  // Prune old entries (keep last 24h)
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  await db.processedEvents.where('timestamp').below(cutoff).delete()
}

export async function getProcessedEvent(id: string): Promise<ProcessedEvent | undefined> {
  return db.processedEvents.get(id)
}

// Pending push events captured by the service worker while the app runtime is not available.
export async function savePendingPushEvent(event: PendingPushEvent): Promise<void> {
  await db.pendingPushEvents.put(event)
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  await db.pendingPushEvents.where('timestamp').below(cutoff).delete()
}

export async function getPendingPushEvents(): Promise<PendingPushEvent[]> {
  return db.pendingPushEvents.orderBy('timestamp').toArray()
}

export async function deletePendingPushEvent(id: string): Promise<void> {
  await db.pendingPushEvents.delete(id)
}

// Group operations
export async function saveGroup(group: StoredGroup): Promise<void> {
  await db.groups.put(group)
}

export async function getAllGroups(): Promise<StoredGroup[]> {
  return db.groups.toArray()
}

export async function deleteGroupFromDb(id: string): Promise<void> {
  await db.groups.delete(id)
}

// Clear all data (for logout)
export async function clearAllData(): Promise<void> {
  await Promise.all([
    db.sessions.clear(),
    db.messages.clear(),
    db.profiles.clear(),
    db.invites.clear(),
    db.processedEvents.clear(),
    db.groups.clear(),
    db.sessionManager.clear(),
    db.pendingPushEvents.clear()
  ])
}

// SessionManager key-value storage operations
export async function getSessionManagerValue<T = unknown>(key: string): Promise<T | undefined> {
  const record = await db.sessionManager.get(key)
  return record?.value as T | undefined
}

export async function putSessionManagerValue<T = unknown>(key: string, value: T): Promise<void> {
  await db.sessionManager.put({ key, value })
}

export async function deleteSessionManagerValue(key: string): Promise<void> {
  await db.sessionManager.delete(key)
}

export async function listSessionManagerKeys(prefix = ''): Promise<string[]> {
  if (!prefix) {
    const all = await db.sessionManager.toArray()
    return all.map((item) => item.key)
  }
  const all = await db.sessionManager
    .filter((item) => item.key.startsWith(prefix))
    .toArray()
  return all.map((item) => item.key)
}

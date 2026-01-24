// IndexedDB storage for chat sessions

const DB_NAME = 'iris-chat'
const DB_VERSION = 1
const SESSIONS_STORE = 'sessions'
const MESSAGES_STORE = 'messages'

let db: IDBDatabase | null = null

export interface StoredSession {
  id: string
  recipientPubkey: string
  sessionState: string // JSON-serialized session state with base64 encoded Uint8Arrays
  createdAt: number
}

export interface StoredMessage {
  id: string
  sessionId: string
  content: string
  timestamp: number
  isMine: boolean
}

// Initialize the database
export function initDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (db) {
      resolve(db)
      return
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => reject(request.error)

    request.onsuccess = () => {
      db = request.result
      resolve(db)
    }

    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result

      // Sessions store
      if (!database.objectStoreNames.contains(SESSIONS_STORE)) {
        database.createObjectStore(SESSIONS_STORE, { keyPath: 'id' })
      }

      // Messages store with index by sessionId
      if (!database.objectStoreNames.contains(MESSAGES_STORE)) {
        const messagesStore = database.createObjectStore(MESSAGES_STORE, { keyPath: 'id' })
        messagesStore.createIndex('sessionId', 'sessionId', { unique: false })
      }
    }
  })
}

// Helper to convert Uint8Array to base64
function uint8ArrayToBase64(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr))
}

// Helper to convert base64 to Uint8Array
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// Deep serialize session state, converting Uint8Arrays to base64
export function serializeSessionState(state: unknown): string {
  return JSON.stringify(state, (key, value) => {
    if (value instanceof Uint8Array) {
      return { __type: 'Uint8Array', data: uint8ArrayToBase64(value) }
    }
    return value
  })
}

// Deep deserialize session state, converting base64 back to Uint8Arrays
export function deserializeSessionState(json: string): unknown {
  return JSON.parse(json, (key, value) => {
    if (value && typeof value === 'object' && value.__type === 'Uint8Array') {
      return base64ToUint8Array(value.data)
    }
    return value
  })
}

// Save a session to IndexedDB
export async function saveSession(session: StoredSession): Promise<void> {
  const database = await initDB()
  return new Promise((resolve, reject) => {
    const tx = database.transaction(SESSIONS_STORE, 'readwrite')
    const store = tx.objectStore(SESSIONS_STORE)
    const request = store.put(session)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve()
  })
}

// Get all sessions from IndexedDB
export async function getAllSessions(): Promise<StoredSession[]> {
  const database = await initDB()
  return new Promise((resolve, reject) => {
    const tx = database.transaction(SESSIONS_STORE, 'readonly')
    const store = tx.objectStore(SESSIONS_STORE)
    const request = store.getAll()
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result || [])
  })
}

// Delete a session from IndexedDB
export async function deleteSession(id: string): Promise<void> {
  const database = await initDB()
  return new Promise((resolve, reject) => {
    const tx = database.transaction(SESSIONS_STORE, 'readwrite')
    const store = tx.objectStore(SESSIONS_STORE)
    const request = store.delete(id)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve()
  })
}

// Save a message to IndexedDB
export async function saveMessage(message: StoredMessage): Promise<void> {
  const database = await initDB()
  return new Promise((resolve, reject) => {
    const tx = database.transaction(MESSAGES_STORE, 'readwrite')
    const store = tx.objectStore(MESSAGES_STORE)
    const request = store.put(message)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve()
  })
}

// Get all messages for a session
export async function getMessagesForSession(sessionId: string): Promise<StoredMessage[]> {
  const database = await initDB()
  return new Promise((resolve, reject) => {
    const tx = database.transaction(MESSAGES_STORE, 'readonly')
    const store = tx.objectStore(MESSAGES_STORE)
    const index = store.index('sessionId')
    const request = index.getAll(sessionId)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result || [])
  })
}

// Delete all messages for a session
export async function deleteMessagesForSession(sessionId: string): Promise<void> {
  const database = await initDB()
  const messages = await getMessagesForSession(sessionId)
  return new Promise((resolve, reject) => {
    const tx = database.transaction(MESSAGES_STORE, 'readwrite')
    const store = tx.objectStore(MESSAGES_STORE)
    let pending = messages.length
    if (pending === 0) {
      resolve()
      return
    }
    for (const msg of messages) {
      const request = store.delete(msg.id)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        pending--
        if (pending === 0) resolve()
      }
    }
  })
}

// Clear all data (for logout)
export async function clearAllData(): Promise<void> {
  const database = await initDB()
  return new Promise((resolve, reject) => {
    const tx = database.transaction([SESSIONS_STORE, MESSAGES_STORE], 'readwrite')
    tx.objectStore(SESSIONS_STORE).clear()
    tx.objectStore(MESSAGES_STORE).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

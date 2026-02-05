import type { StorageAdapter } from 'nostr-double-ratchet/dist/nostr-double-ratchet.es.js'
import {
  getSessionManagerValue,
  putSessionManagerValue,
  deleteSessionManagerValue,
  listSessionManagerKeys,
} from './storage'

export class DexieStorageAdapter implements StorageAdapter {
  async get<T = unknown>(key: string): Promise<T | undefined> {
    return getSessionManagerValue<T>(key)
  }

  async put<T = unknown>(key: string, value: T): Promise<void> {
    await putSessionManagerValue(key, value)
  }

  async del(key: string): Promise<void> {
    await deleteSessionManagerValue(key)
  }

  async list(prefix = ''): Promise<string[]> {
    return listSessionManagerKeys(prefix)
  }
}

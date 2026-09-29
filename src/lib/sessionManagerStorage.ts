import type { StorageAdapter } from 'nostr-double-ratchet'
import {
  getSessionManagerValue,
  putSessionManagerValue,
  deleteSessionManagerValue,
  listSessionManagerKeys,
} from './storage'

export class DexieStorageAdapter implements StorageAdapter {
  private closed = false

  close(): void { this.closed = true }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    if (this.closed) return undefined
    const value = await getSessionManagerValue<T>(key)
    return this.closed ? undefined : value
  }

  async put<T = unknown>(key: string, value: T): Promise<void> {
    if (this.closed) return
    await putSessionManagerValue(key, value)
  }

  async del(key: string): Promise<void> {
    if (this.closed) return
    await deleteSessionManagerValue(key)
  }

  async list(prefix = ''): Promise<string[]> {
    if (this.closed) return []
    const keys = await listSessionManagerKeys(prefix)
    return this.closed ? [] : keys
  }
}

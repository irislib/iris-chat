import type { StorageAdapter } from 'nostr-double-ratchet'
import {
  getSessionManagerValue,
  putSessionManagerValue,
  deleteSessionManagerValue,
  listSessionManagerKeys,
} from './storage'

export class DexieStorageAdapter implements StorageAdapter {
  private closed = false
  constructor(private readonly owner?: string) {}

  // Retire legacy own-device copies before queue replay or inbox persistence.
  // Participant delivery stays in NDR; own-device changes use private history.
  private async filterOwnMutations<T>(key: string, value: T): Promise<T | undefined> {
    if (!this.owner || !value || typeof value !== 'object') return value
    const row = value as Record<string, any>
    const mutation = (event: any) => event?.kind === 1009 || event?.kind === 5
    if (key === `v1/user/${this.owner}` && Array.isArray(row.pendingDurableEvents)) {
      const retained = row.pendingDurableEvents.filter(entry =>
        !(entry.sender === this.owner && entry.meta?.senderOwnerPubkey === this.owner && mutation(entry.event)))
      return retained.length === row.pendingDurableEvents.length ? value : { ...row, pendingDurableEvents: retained } as T
    }
    if (!mutation(row.event) || row.event.pubkey !== this.owner || typeof row.targetKey !== 'string') return value
    if (key === `v1/discovery-queue/${row.event.id}/${row.targetKey}` && row.targetKey === this.owner) return undefined
    if (key === `v1/message-queue/${row.event.id}/${row.targetKey}`) {
      const own = await getSessionManagerValue<{ devices?: Array<{ deviceId: string }> }>(`v1/user/${this.owner}`)
      if (own?.devices?.some(device => device.deviceId === row.targetKey)) return undefined
    }
    return value
  }

  close(): void { this.closed = true }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    if (this.closed) return undefined
    const stored = await getSessionManagerValue<T>(key)
    const value = await this.filterOwnMutations(key, stored)
    if (!this.closed && value !== stored) {
      if (value === undefined) await deleteSessionManagerValue(key)
      else await putSessionManagerValue(key, value)
    }
    return this.closed ? undefined : value
  }

  async put<T = unknown>(key: string, value: T): Promise<void> {
    if (this.closed) return
    const filtered = await this.filterOwnMutations(key, value)
    if (this.closed) return
    if (filtered === undefined) await deleteSessionManagerValue(key)
    else await putSessionManagerValue(key, filtered)
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

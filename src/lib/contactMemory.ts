import { createContactMemoryStore } from '@iris/svelte-ui/contactMemoryStore'
import { putSessionManagerValue } from './storage'

// Iris Kit owns the portable memory policy and account-scoped persistence.
export const contactMemory = createContactMemoryStore({
  getItem: key => localStorage.getItem(key),
  setItem: (key, value) => {
    localStorage.setItem(key, value)
    // Notifications run in a worker without localStorage. Mirror the private
    // record into its existing local database, never onto the network.
    void putSessionManagerValue(key, JSON.parse(value)).catch(() => {})
  },
})
const publicNames = new Map<string, string | null>()

export function restoreContactNamesForNotifications(account: string | null) {
  if (!account) return
  const prefix = `iris-contact-memory:v1:${account}:`
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (!key?.startsWith(prefix)) continue
    const memory = contactMemory.get(account, key.slice(prefix.length))
    if (memory) void putSessionManagerValue(key, memory).catch(() => {})
  }
}

export function observeContactProfile(account: string, pubkey: string, name: string | null) {
  publicNames.set(pubkey, name)
  if (account) contactMemory.observeKnown(account, pubkey, name)
}

export function rememberContact(account: string, pubkey: string) {
  if (!account || account === pubkey) return
  contactMemory.remember(account, pubkey, publicNames.get(pubkey) ?? null)
}

export function favoriteContact(account: string, pubkey: string, favorite: boolean) {
  contactMemory.setFavorite(account, pubkey, favorite, publicNames.get(pubkey) ?? null)
}

export function approveContactName(account: string, pubkey: string, expected: string) {
  return contactMemory.approve(account, pubkey, expected, publicNames.get(pubkey) ?? null, Math.floor(Date.now() / 1000))
}

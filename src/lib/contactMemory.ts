import { createContactMemoryStore } from '@iris/svelte-ui/contactMemoryStore'
import { putSessionManagerValue } from './storage'
import { emptyContactMemory } from '@iris/svelte-ui/contactMemory'
import { editPrivateContact, getPrivateContact, privateContactsVersion } from './privateContactSync'

// Iris Kit owns the portable memory policy and account-scoped persistence.
const localMemory = createContactMemoryStore({
  getItem: key => localStorage.getItem(key),
  setItem: (key, value) => {
    localStorage.setItem(key, value)
    // Notifications run in a worker without localStorage. Preserve the synced
    // nickname when a local observed-name update refreshes that worker's copy.
    const [, account, contact] = key.match(/^iris-contact-memory:v1:([a-f0-9]{64}):([a-f0-9]{64})$/) ?? []
    const synced = account && contact ? getPrivateContact(account, contact) : undefined
    void putSessionManagerValue(key, { ...JSON.parse(value), ...synced }).catch(() => {})
  },
})
export const contactMemory = {
  ...localMemory,
  get(account: string, pubkey: string) {
    const local = localMemory.get(account, pubkey)
    const synced = getPrivateContact(account, pubkey)
    return synced ? { ...(local ?? emptyContactMemory()), ...synced } : local ? { ...local, nickname: null, note: null } : null
  },
  subscribe(run: (version: number) => void) {
    let version = 0
    const a = localMemory.subscribe(() => run(++version))
    const b = privateContactsVersion.subscribe(() => run(++version))
    return () => { a(); b() }
  },
}
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

export function projectPrivateContacts(account: string, pubkeys: string[]) {
  for (const pubkey of pubkeys) {
    const synced = getPrivateContact(account, pubkey)
    if (!synced) continue
    const local = localMemory.get(account, pubkey)
    if (!local || local.favorite !== synced.favorite) localMemory.setFavorite(account, pubkey, synced.favorite, null)
    const memory = contactMemory.get(account, pubkey)
    if (memory) void putSessionManagerValue(`iris-contact-memory:v1:${account}:${pubkey}`, memory).catch(() => {})
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

export async function favoriteContact(account: string, pubkey: string, favorite: boolean) {
  await editPrivateContact(pubkey, { favorite })
  localMemory.setFavorite(account, pubkey, favorite, publicNames.get(pubkey) ?? null)
}

export function approveContactName(account: string, pubkey: string, expected: string) {
  return contactMemory.approve(account, pubkey, expected, publicNames.get(pubkey) ?? null, Math.floor(Date.now() / 1000))
}

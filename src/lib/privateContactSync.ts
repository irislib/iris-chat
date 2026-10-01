import { migrateStoredPrivateContacts, privateContactStorageKey } from './privateContactMigration'
import { get, writable } from 'svelte/store'
import { migratePrivateContactSync, privateContactValues,
  privateContactDocuments, type PrivateContactDocument, type PrivateContactPatch,
  type PrivateContactSyncState } from 'nostr-social-graph/privateContactSyncV2'
import { createPrivateContactSyncController, type PrivateContactSyncController,
  type PrivateContactSyncStatus } from 'nostr-social-graph/privateContactSyncV2Controller'
import { identity, type Identity } from './identity'

export const privateContactsVersion = writable(0)
export const privateContactsStatus = writable<PrivateContactSyncStatus>('local-only')
const keyFor = privateContactStorageKey
let current: PrivateContactSyncController | undefined
let owner = ''
let stopAccount: (() => void) | undefined
let generation = 0

export function getPrivateContact(ownerKey: string, contact: string) {
  if (ownerKey !== owner || !current) return undefined
  const state = current.getState()
  return state.contacts[contact] ? privateContactValues(state, contact) : undefined
}
export function getPrivateContactDocuments(): PrivateContactDocument[] {
  return current ? privateContactDocuments(current.getState()) : []
}
export async function mergePrivateContacts(account: string, documents: PrivateContactDocument[]) {
  if (account !== owner || get(identity)?.pubkey !== account || !current) throw new Error('Private details account is not ready')
  const active = current
  for (const document of documents) {
    if (active !== current || account !== owner) throw new Error('Account changed')
    await active.mergeTrusted(document)
  }
}
export async function queuePrivateContacts(account: string) {
  if (account !== owner || get(identity)?.pubkey !== account || !current) throw new Error('Private details account is not ready')
  await current.queueSnapshot()
}
export async function editPrivateContact(contact: string, patch: PrivateContactPatch) {
  const account = get(identity)?.pubkey
  if (!account || account !== owner || !current) throw new Error('Private details are not ready. Try again.')
  await current.edit(contact, patch)
}

async function activate(account: Identity | null) {
  if ((account?.pubkey ?? '') === owner) return
  const token = ++generation
  current?.stop(); current = undefined
  owner = account?.pubkey ?? ''
  privateContactsVersion.update(value => value + 1)
  privateContactsStatus.set('local-only')
  if (!account) return
  if (!navigator.locks) { privateContactsStatus.set('error'); return }
  const accountOwner = owner
  const load = () => {
    const saved = localStorage.getItem(keyFor(accountOwner))
    return saved ? migratePrivateContactSync(JSON.parse(saved), accountOwner) : null
  }
  let state: PrivateContactSyncState
  try {
    state = await migrateStoredPrivateContacts(accountOwner)
  } catch { if (token === generation) privateContactsStatus.set('error'); return }
  if (token !== generation) return
  const controller = createPrivateContactSyncController({ state,
    withLock: async run => { await navigator.locks.request(keyFor(accountOwner), run) },
    load,
    save: next => localStorage.setItem(keyFor(accountOwner), JSON.stringify(next)),
    send: async document => {
      if (token !== generation) return false
      const { sendPrivateContactDocument } = await import('./privateContactControl')
      return token === generation && await sendPrivateContactDocument(accountOwner, document)
    },
    onChange: (_next, change) => {
      if (token !== generation || change.source === 'ack') return
      privateContactsVersion.update(value => value + 1)
      void import('./contactMemory').then(({ projectPrivateContacts }) => {
        if (token === generation) projectPrivateContacts(accountOwner, change.contact ? [change.contact] : Object.keys(_next.contacts))
      })
    },
    onStatus: status => { if (token === generation) privateContactsStatus.set(status) },
  })
  current = controller
  privateContactsStatus.set(controller.getStatus())
  privateContactsVersion.update(value => value + 1)
  void import('./contactMemory').then(({ projectPrivateContacts }) => {
    if (token === generation) projectPrivateContacts(accountOwner, Object.keys(state.contacts))
  })
  const prefix = `iris-contact-memory:v1:${owner}:`
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (!key?.startsWith(prefix)) continue
    try {
      const legacy = JSON.parse(localStorage.getItem(key) ?? '{}')
      if (legacy.favorite === true) await controller.seed(key.slice(prefix.length), { favorite: true })
    } catch { /* Preserve malformed legacy records without overwriting them. */ }
  }
  if (token === generation) controller.retry()
}
export function resumePrivateContactSync() { current?.retry() }
export function startPrivateContactSync() {
  if (stopAccount) return
  stopAccount = identity.subscribe(account => {
    const activation = activate(account), token = generation
    void activation.catch(() => { if (token === generation) privateContactsStatus.set('error') })
  })
  const retry = () => current?.retry()
  window.addEventListener('online', retry)
  const visible = () => { if (!document.hidden) retry() }
  document.addEventListener('visibilitychange', visible)
  const changed = (event: StorageEvent) => {
    if (event.key === keyFor(owner)) void current?.refresh().catch(() => privateContactsStatus.set('error'))
  }
  window.addEventListener('storage', changed)
  return () => {
    stopAccount?.(); stopAccount = undefined
    void activate(null)
    window.removeEventListener('online', retry)
    document.removeEventListener('visibilitychange', visible)
    window.removeEventListener('storage', changed)
  }
}

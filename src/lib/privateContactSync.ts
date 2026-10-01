import { get, writable } from 'svelte/store'
import { createPrivateContactSync, restorePrivateContactSync, privateContactValues,
  privateContactSyncFilter, privateContactDocuments, type PrivateContactDocument, type PrivateContactPatch,
  type PrivateContactSyncState } from 'nostr-social-graph/privateContactSync'
import { createPrivateContactSyncController, type PrivateContactSyncController,
  type PrivateContactSyncStatus } from 'nostr-social-graph/privateContactSyncController'
import { identity, nostrClient, type Identity } from './identity'
import { relayStore } from './relayStore'

export const privateContactsVersion = writable(0)
export const privateContactsStatus = writable<PrivateContactSyncStatus>('local-only')
export const privateContactsNeedSigner = writable(false)
const keyFor = (owner: string) => `nostr-social-memory:v1:${owner}`
let current: PrivateContactSyncController | undefined
let owner = ''
let stopEvents: (() => void) | undefined
let stopAccount: (() => void) | undefined
let generation = 0
let historyRun: Promise<void> | undefined
let historyRetry: ReturnType<typeof setTimeout> | undefined
let activeSigner: Identity['signer']
let signerPaused = false
const randomId = () => crypto.randomUUID().replaceAll('-', '')

export function getPrivateContact(ownerKey: string, contact: string) {
  if (ownerKey !== owner || !current) return undefined
  const state = current.getState()
  return state.contacts[contact] ? privateContactValues(state, contact) : undefined
}
export function getPrivateContactDocuments(): PrivateContactDocument[] {
  return current ? privateContactDocuments(current.getState()) : []
}
export async function mergePrivateContacts(account: string, documents: PrivateContactDocument[]) {
  if (account !== owner || get(identity)?.pubkey !== account || !current) return
  const active = current
  for (const document of documents) {
    if (active !== current || account !== owner) return
    await active.mergeTrusted(document)
  }
}
export async function editPrivateContact(contact: string, patch: PrivateContactPatch) {
  const account = get(identity)?.pubkey
  if (!account || account !== owner || !current) throw new Error('Private details are not ready. Try again.')
  await current.edit(contact, patch)
}

function readHistory(token: number, controller: PrivateContactSyncController): Promise<void> {
  if (historyRun) return historyRun
  const run = (async () => {
    const client = get(nostrClient)
    controller.beginRead()
    try {
      const relays = [...relayStore.getState().relays]
      if (!relays.length) throw new Error('No message servers')
      let allComplete = true
      for (const relay of relays) {
        try {
        let until: number | undefined
        let limit = 256
        let complete = false
        for (let page = 0; page < 100 && token === generation; page++) {
          const result = await client.runtime.query([{ ...privateContactSyncFilter(owner), limit, ...(until === undefined ? {} : { until }) }], { cache: 'network-only', includeSuperseded: true, relays: [relay] })
          if (token !== generation) return
          for (const event of result.events) await controller.receive(event)
          if (!result.complete) throw new Error('Private sync is waiting for message servers')
          if (result.events.length < limit) { complete = true; break }
          const oldest = Math.min(...result.events.map(event => event.created_at))
          if (oldest === until) {
            if (limit >= 8192) throw new Error('Private sync could not finish loading')
            limit *= 2
          } else { until = oldest; limit = 256 }
        }
        if (!complete) throw new Error('Private sync could not finish loading')
        } catch { allComplete = false }
      }
      if (!allComplete) throw new Error('Private sync is waiting for message servers')
      await controller.markReady()
    } catch {
      if (token !== generation) return
      await controller.markReady(false)
      clearTimeout(historyRetry)
      historyRetry = setTimeout(() => { if (token === generation) void readHistory(token, controller) }, 30_000)
    }
  })()
  historyRun = run
  void run.finally(() => { if (historyRun === run) historyRun = undefined })
  return run
}

function activate(account: Identity | null) {
  if ((account?.pubkey ?? '') === owner && account?.signer === activeSigner) return
  const token = ++generation
  clearTimeout(historyRetry); historyRun = undefined
  current?.stop(); current = undefined; stopEvents?.(); stopEvents = undefined
  owner = account?.pubkey ?? ''
  activeSigner = account?.signer
  signerPaused = false; privateContactsNeedSigner.set(false)
  privateContactsVersion.update(value => value + 1)
  privateContactsStatus.set('local-only')
  if (!account) return
  if (!navigator.locks) { privateContactsStatus.set('error'); return }
  let state: PrivateContactSyncState
  try {
    const saved = localStorage.getItem(keyFor(owner))
    state = saved ? restorePrivateContactSync(JSON.parse(saved), owner) : createPrivateContactSync(owner, randomId())
  } catch { privateContactsStatus.set('error'); return }
  const accountOwner = owner
  const signer = account.signer
  const withSigner = async <T>(run: () => Promise<T>): Promise<T> => {
    if (signerPaused) throw new Error('Private sync is waiting for your signer')
    try { return await run() }
    catch (error) {
      if (account.isNip07 && token === generation) { signerPaused = true; privateContactsNeedSigner.set(true) }
      throw error
    }
  }
  const client = get(nostrClient)
  const controller = createPrivateContactSyncController({ state,
    withLock: async run => { await navigator.locks.request(keyFor(accountOwner), run) },
    load: () => {
      const saved = localStorage.getItem(keyFor(accountOwner))
      return saved ? restorePrivateContactSync(JSON.parse(saved), accountOwner) : null
    },
    save: next => localStorage.setItem(keyFor(accountOwner), JSON.stringify(next)),
    ...(signer ? { signer: {
      getPublicKey: async () => {
        if (get(identity)?.pubkey !== accountOwner) throw new Error('Account changed')
        return (await withSigner(() => signer.user())).pubkey
      },
      signEvent: draft => withSigner(() => signer.signEvent(draft)),
      nip44Encrypt: (recipient, content) => withSigner(() => signer.nip44Encrypt(recipient, content)),
      nip44Decrypt: (sender, content) => withSigner(() => signer.nip44Decrypt(sender, content)),
    }, publish: async event => {
      if (token !== generation) return false
      const result = await client.runtime.publish(event, { requireAck: true, queue: false, localEcho: false })
      return token === generation && result.remoteAccepted
    } } : {}),
    onChange: (_next, change) => {
      if (token !== generation) return
      if (change.source === 'prepared' || change.source === 'ack') return
      privateContactsVersion.update(value => value + 1)
      void import('./contactMemory').then(({ projectPrivateContacts }) => {
        if (token === generation) projectPrivateContacts(accountOwner, change.contact ? [change.contact] : Object.keys(_next.contacts))
      })
      if (change.source === 'local' || change.source === 'remote') {
        void import('./privateContactControl').then(({ sendPrivateContactDocument }) => {
          if (token !== generation) return
          const document = privateContactDocuments(controller.getState()).find(item => item.contact === change.contact)
          if (document) return sendPrivateContactDocument(accountOwner, document)
        }).catch(() => {})
      }
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
      if (legacy.favorite === true) void controller.seed(key.slice(prefix.length), { favorite: true }).catch(() => {})
    } catch { /* Preserve malformed legacy records without overwriting them. */ }
  }
  if (signer) {
    const sub = client.runtime.subscribe([privateContactSyncFilter(owner)], {
      onEvent: event => { void controller.receive(event).catch(() => {}) },
    }, { cache: 'cache-first' })
    stopEvents = () => sub.close()
    void readHistory(token, controller)
  }
}
export function resumePrivateContactSync() {
  signerPaused = false; privateContactsNeedSigner.set(false)
  current?.retry()
  if (current && get(identity)?.signer) void readHistory(generation, current)
}
export function startPrivateContactSync() {
  if (stopAccount) return
  stopAccount = identity.subscribe(activate)
  const retry = () => { current?.retry(); if (current && get(identity)?.signer) void readHistory(generation, current) }
  window.addEventListener('online', retry)
  const visible = () => { if (!document.hidden) retry() }
  document.addEventListener('visibilitychange', visible)
  const changed = (event: StorageEvent) => {
    if (event.key === keyFor(owner)) void current?.refresh().catch(() => privateContactsStatus.set('error'))
  }
  window.addEventListener('storage', changed)
  return () => {
    stopAccount?.(); stopAccount = undefined
    activate(null)
    window.removeEventListener('online', retry)
    document.removeEventListener('visibilitychange', visible)
    window.removeEventListener('storage', changed)
  }
}

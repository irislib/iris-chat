import { WebSocket } from 'ws'
import { setImmediate as yieldToIo } from 'node:timers/promises'
import { finalizeEvent, generateSecretKey, getPublicKey, getEventHash, verifyEvent, type Filter, type UnsignedEvent, type VerifiedEvent } from 'nostr-tools'
import {
  AppKeys, CHAT_MESSAGE_KIND, GROUP_SENDER_KEY_DISTRIBUTION_KIND, InMemoryStorageAdapter, NdrRuntime,
  isGroupRosterFactEvent, parseGroupRosterFactRumor, validateMetadataCreation,
  type GroupData, type StorageAdapter,
} from 'nostr-double-ratchet'

class SnapshotStorage implements StorageAdapter {
  private closed = false
  constructor(private backing = new InMemoryStorageAdapter(), private counters = { reads: 0 }) {}
  get reads() { return this.counters.reads }
  reopen() { return new SnapshotStorage(this.backing, this.counters) }
  close() { this.closed = true }
  async get<T = unknown>(key: string): Promise<T | undefined> {
    if (this.closed) return undefined
    this.counters.reads++
    await yieldToIo()
    const value = await this.backing.get<T>(key)
    return this.closed ? undefined : structuredClone(value)
  }
  async put<T = unknown>(key: string, value: T): Promise<void> {
    const snapshot = structuredClone(value)
    // IndexedDB yields to IO. Resolving every simulated device's storage work
    // in microtasks otherwise starves sockets and timers in the shared process.
    await yieldToIo()
    if (!this.closed) await this.backing.put(key, snapshot)
  }
  async del(key: string): Promise<void> { await yieldToIo(); if (!this.closed) await this.backing.del(key) }
  async list(prefix = ''): Promise<string[]> { await yieldToIo(); return this.closed ? [] : this.backing.list(prefix) }
}

/** Real NIP-01 sockets: the farm never shares decrypted messages or ratchet state. */
class RelayClient {
  private socket: WebSocket
  private nextId = 0
  private subscriptions = new Map<string, { event: (event: VerifiedEvent) => void; eose?: () => void }>()
  private acknowledgements = new Map<string, Array<{ resolve: () => void; reject: (error: Error) => void }>>()
  private verifiedEvents = new Map<string, { serialized: string; event: VerifiedEvent }>()
  private pendingFetches = new Set<(error: Error) => void>()
  readonly publishedDirectEvents = new Map<string, { author: string; recipients: string[] }>()
  readonly receivedDirectIds = new Set<string>()
  readonly ready: Promise<void>

  constructor(url: string) {
    this.socket = new WebSocket(url)
    this.ready = new Promise((resolve, reject) => {
      this.socket.once('open', resolve)
      this.socket.once('error', reject)
    })
    this.socket.on('message', (data) => {
      const [type, id, payload, reason] = JSON.parse(data.toString())
      if (type === 'EVENT') {
        const subscription = this.subscriptions.get(id)
        if (!subscription) return
        // Model NDK's verification cache independently for every simulated
        // device. Historical/live duplicates still reach the real runtime.
        const serialized = JSON.stringify(payload)
        let cached = this.verifiedEvents.get(payload.id)
        if (cached?.serialized !== serialized) {
          if (!verifyEvent(payload)) return
          cached = { serialized, event: payload }
          this.verifiedEvents.set(payload.id, cached)
          if (this.verifiedEvents.size > 4096) this.verifiedEvents.delete(this.verifiedEvents.keys().next().value!)
        }
        if (payload.kind === 1060) {
          this.receivedDirectIds.add(payload.id)
          if (this.receivedDirectIds.size > 4096) this.receivedDirectIds.delete(this.receivedDirectIds.values().next().value!)
        }
        subscription.event(cached.event)
      }
      if (type === 'EOSE') this.subscriptions.get(id)?.eose?.()
      if (type === 'OK') {
        const pending = this.acknowledgements.get(id)
        this.acknowledgements.delete(id)
        for (const waiter of pending ?? []) {
          if (payload) waiter.resolve()
          else waiter.reject(new Error(reason))
        }
      }
    })
    this.socket.on('close', () => this.abort(new Error('Relay connection closed')))
    this.socket.on('error', (error) => this.abort(error))
  }

  subscribe = (filter: Filter, event: (event: VerifiedEvent) => void, eose?: () => void) => {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Relay connection is not open')
    const id = String(++this.nextId)
    this.subscriptions.set(id, { event, eose })
    this.socket.send(JSON.stringify(['REQ', id, filter]))
    return () => {
      this.subscriptions.delete(id)
      if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(['CLOSE', id]))
    }
  }

  fetch = (filter: Filter): Promise<VerifiedEvent[]> => new Promise((resolve, reject) => {
    const events: VerifiedEvent[] = []
    const failed = (error: Error) => { stop(); reject(error) }
    const stop = this.subscribe(filter, (event) => events.push(event), () => {
      this.pendingFetches.delete(failed)
      stop()
      resolve(events)
    })
    this.pendingFetches.add(failed)
  })

  publish = async (event: VerifiedEvent) => {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Relay connection is not open')
    if (event.kind === 1060) this.publishedDirectEvents.set(event.id, {
      author: event.pubkey, recipients: event.tags.filter((tag) => tag[0] === 'p').map((tag) => tag[1]!),
    })
    await new Promise<void>((resolve, reject) => {
      const pending = this.acknowledgements.get(event.id) ?? []
      pending.push({ resolve, reject })
      this.acknowledgements.set(event.id, pending)
      this.socket.send(JSON.stringify(['EVENT', event]), (error) => { if (error) this.abort(error) })
    })
    return event
  }

  close() {
    this.abort(new Error('Relay client stopped'))
    this.socket.close()
  }

  private abort(error: Error) {
    this.subscriptions.clear()
    for (const waiters of this.acknowledgements.values()) for (const waiter of waiters) waiter.reject(error)
    this.acknowledgements.clear()
    for (const failed of this.pendingFetches) failed(error)
    this.pendingFetches.clear()
  }
}

export class GroupFarmDevice {
  onChange?: () => void
  readonly owner: string
  storage = new SnapshotStorage()
  readonly groups = new Map<string, GroupData>()
  readonly messages = new Map<string, string>()
  readonly receivedKeyHandoffs = new Map<string, string>()
  readonly failures: string[] = []
  runtime!: NdrRuntime
  private relay!: RelayClient

  constructor(owner: string, private url: string, private ownerIdentityKey?: Uint8Array) {
    this.owner = owner
  }

  async start() {
    this.storage = this.storage.reopen()
    const relay = this.relay = new RelayClient(this.url)
    await relay.ready
    const runtime = this.runtime = new NdrRuntime({
      storage: this.storage,
      ...(this.ownerIdentityKey ? { ownerIdentityKey: this.ownerIdentityKey } : {}),
      nostrSubscribe: relay.subscribe, nostrFetch: relay.fetch,
      nostrPublish: async (event: UnsignedEvent | VerifiedEvent) => {
        if ('sig' in event) return relay.publish(event)
        if (!this.ownerIdentityKey) throw new Error('Linked runtime must sign with its own device key')
        return relay.publish(finalizeEvent(event, this.ownerIdentityKey))
      },
      appKeysFetchTimeoutMs: 50, appKeysFastTimeoutMs: 20,
    })
    runtime.onGroupEvent((event) => {
      if (isGroupRosterFactEvent(event.inner)) {
        const fact = parseGroupRosterFactRumor(event.inner)
        if (!validateMetadataCreation(fact.group, fact.signerPubkey, this.owner)) {
          this.failures.push('Unauthorized group metadata')
          return
        }
        void runtime.upsertGroup(fact.group)
          .then(() => { this.groups.set(fact.groupId, fact.group); this.onChange?.() })
          .catch((error) => { this.failures.push(String(error)); this.onChange?.() })
      } else if (event.inner.kind === CHAT_MESSAGE_KIND) {
        // Iris keeps the owner-authored rumor inside the device-authored group
        // payload for native interop. Validate its hash before rendering it.
        let rumor = event.inner
        try {
          const nested = JSON.parse(rumor.content)
          if (nested?.id === getEventHash(nested)
            && nested.pubkey === event.senderOwnerPubkey
            && nested.tags.some((tag: string[]) => tag[0] === 'l' && tag[1] === event.groupId)) rumor = nested
        } catch { /* A plain text group message has no nested rumor. */ }
        this.messages.set(rumor.id, rumor.content)
        this.onChange?.()
      }
    })
    runtime.onSessionEvent((event, _from, meta) => {
      if (event.kind === GROUP_SENDER_KEY_DISTRIBUTION_KIND) {
        this.receivedKeyHandoffs.set(event.id, meta?.senderDevicePubkey ?? meta?.fromDeviceId ?? '')
        this.onChange?.()
      }
    })
    runtime.onStateChange(() => this.onChange?.())
    await runtime.initForOwner(this.owner)
    for (const group of this.groups.values()) await runtime.upsertGroup(group)
    this.onChange?.()
  }

  async register(devices: GroupFarmDevice[]) {
    if (!this.ownerIdentityKey) throw new Error('Only the identity holder can authorize devices')
    const roster = new AppKeys(devices.map((device) => ({
      identityPubkey: device.runtime.getState().currentDevicePubkey!,
      createdAt: Math.floor(Date.now() / 1000),
    })))
    await this.relay.publish(finalizeEvent(roster.getEvent({ ownerPrivateKey: this.ownerIdentityKey }), this.ownerIdentityKey))
    for (const device of devices) {
      await device.runtime.refreshOwnAppKeysFromRelay(device.owner, 50)
      await device.runtime.republishInvite()
      if (device.runtime.getState().registeredDevices.length !== devices.length) {
        throw new Error('Fixture did not discover its complete signed device roster')
      }
    }
  }

  async send(groupId: string, content: string) {
    const result = await this.runtime.sendGroupMessage(groupId, content)
    // The sending device renders its locally returned rumor, just like the app.
    this.messages.set(result.inner.id, result.inner.content)
    this.onChange?.()
    return { id: result.inner.id, content: result.inner.content }
  }

  getState() { return this.runtime.getState() }

  sendContact(owner: string, content: string) { return this.runtime.sendMessage(owner, content) }

  async diagnostics() {
    const closed = !this.getState().ownerPubkey
    const queue = closed ? [] : await this.runtime.queuedMessageDiagnostics()
    const records = closed ? [] : [...this.runtime.getSessionUserRecords().values()]
    const sessions = records.flatMap((record) => [...(record.devices?.values() ?? [])])
    return { closed, knownOwners: records.length, active: sessions.filter((session) => session.activeSession).length,
      discoveryQueued: queue.filter((entry) => entry.stage === 'discovery').length,
      deviceQueued: queue.filter((entry) => entry.stage === 'device').length, reads: this.storage.reads }
  }

  directHandoffDiagnostics(recipient: GroupFarmDevice) {
    const device = recipient.runtime.getState().currentDevicePubkey!
    const manager = recipient.runtime.getSessionManager()!
    const authors = manager.getAllMessagePushAuthorPubkeys()
    const pending = (manager as unknown as { pendingDirectMessages: Map<string, unknown> }).pendingDirectMessages
    return [...this.relay.publishedDirectEvents].filter(([, event]) => event.recipients.includes(device)).map(([id, event]) => ({
      received: recipient.relay.receivedDirectIds.has(id), pending: pending.has(id), knownAuthor: authors.includes(event.author),
    }))
  }

  stop() {
    // Match the app's old-handle shutdown before opening a new persistent handle.
    this.storage.close()
    this.runtime.close()
    this.relay.close()
    this.onChange?.()
  }
}

export async function createGroupFarm(memberCount: number, url: string, ownerOffset = 0) {
  const owners: GroupFarmDevice[][] = []
  for (let owner = 0; owner < memberCount; owner++) {
    const key = generateSecretKey()
    const index = ownerOffset + owner
    const count = 1 + (index % 5 === 0 ? 2 : index % 2 === 0 ? 1 : 0)
    const devices = Array.from({ length: count }, (_, index) => new GroupFarmDevice(getPublicKey(key), url, index === 0 ? key : undefined))
    owners.push(devices)
    await Promise.all(devices.map((device) => device.start()))
    await devices[0]!.register(devices)
  }
  return owners
}

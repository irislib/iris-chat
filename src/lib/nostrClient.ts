import type { RuntimeCacheMode, RuntimePublishOptions } from 'nostr-pubsub'
import { NostrWorkerClient } from './nostrWorkerClient'
import { createNostrIdentitySignerFromSecretKey, createNostrIdentitySignerFromNip07, type NostrIdentityEventSigner } from '@iris/identity'
import { getPublicKey, type Event, type EventTemplate, type Filter, type VerifiedEvent } from 'nostr-tools'

export type EventFilter = Filter
export const CacheMode = { PARALLEL: 'cache-first', ONLY_RELAY: 'network-only', ONLY_CACHE: 'cache-only' } as const
export type CacheMode = RuntimeCacheMode
export interface Signer {
  pubkey?: string
  user(): Promise<{ pubkey: string }>
  signEvent(event: EventTemplate): Promise<Event>
  nip44Encrypt?(recipient: string, plaintext: string): Promise<string>
  nip44Decrypt?(sender: string, ciphertext: string): Promise<string>
}

export class SecretKeySigner implements Signer {
  private readonly signer: NostrIdentityEventSigner
  readonly pubkey: string
  constructor(readonly privateKey: string) {
    if (!/^[0-9a-f]{64}$/i.test(privateKey)) throw new Error('Invalid secret key')
    const bytes = Uint8Array.from(privateKey.match(/../g)!, value => parseInt(value, 16))
    this.pubkey = getPublicKey(bytes)
    this.signer = createNostrIdentitySignerFromSecretKey(bytes)
  }
  async user() { return { pubkey: this.pubkey } }
  async signEvent(event: EventTemplate) { return this.signer.signEvent(event) }
  async nip44Encrypt(recipient: string, plaintext: string) { return this.signer.nip44Encrypt!(recipient, plaintext) }
  async nip44Decrypt(sender: string, ciphertext: string) { return this.signer.nip44Decrypt!(sender, ciphertext) }
}

export class ExtensionSigner implements Signer {
  pubkey?: string
  constructor(_timeout = 5000) {}
  private extension() {
    if (!window.nostr) throw new Error('No signing extension found')
    return createNostrIdentitySignerFromNip07(window.nostr)
  }
  async user() {
    this.pubkey = await this.extension().getPublicKey()
    return { pubkey: this.pubkey }
  }
  async signEvent(event: EventTemplate) { return this.extension().signEvent(event) }
  async nip44Encrypt(recipient: string, plaintext: string) {
    const signer = this.extension()
    if (!signer.nip44Encrypt) throw new Error('Private sync needs an updated signer')
    return signer.nip44Encrypt(recipient, plaintext)
  }
  async nip44Decrypt(sender: string, ciphertext: string) {
    const signer = this.extension()
    if (!signer.nip44Decrypt) throw new Error('Private sync needs an updated signer')
    return signer.nip44Decrypt(sender, ciphertext)
  }
}

/** Chat's editable event draft. Signing and networking use the shared libraries. */
export class AppEvent implements Event {
  id = ''
  sig = ''
  pubkey = ''
  kind = 1
  created_at = Math.floor(Date.now() / 1000)
  tags: string[][] = []
  content = ''
  constructor(private readonly client?: NostrClient, event?: Partial<Event>) {
    if (event) Object.assign(this, structuredClone(event))
  }
  rawEvent(): VerifiedEvent {
    return { id: this.id, sig: this.sig, pubkey: this.pubkey, kind: this.kind,
      created_at: this.created_at, tags: this.tags.map(tag => [...tag]), content: this.content } as VerifiedEvent
  }
  async toNostrEvent() { return this.rawEvent() }
  async sign(signer = this.client?.signer) {
    if (!signer) throw new Error('Not logged in')
    const event = await signer.signEvent({ kind: this.kind, created_at: this.created_at,
      tags: this.tags.map(tag => [...tag]), content: this.content })
    Object.assign(this, event)
    return this.sig
  }
  async publish(options: RuntimePublishOptions = {}): Promise<Set<{url: string}>> {
    if (!this.client) throw new Error('No event runtime')
    if (!this.sig) await this.sign()
    const result = await this.client.runtime.publish(this.rawEvent(), options)
    if (!result.remoteAccepted && !result.queued) throw new Error('No message server accepted the event')
    return new Set(result.sources.filter(source => source.accepted).map(source => ({ url: source.id })))
  }
}

export interface SubscriptionOptions {
  closeOnEose?: boolean
  cacheUsage?: CacheMode
  relayUrls?: string[]
  skipOptimisticPublishEvent?: boolean
  sources?: readonly string[]
}
export class EventSubscription {
  private readonly eventHandlers = new Set<(event: AppEvent) => void>()
  private readonly endHandlers = new Map<string, Set<() => void>>()
  private handle?: { close(): void }
  private stopped = false
  constructor(private readonly client: NostrClient, private readonly filters: Filter[], private readonly options: SubscriptionOptions) {}
  on(name: 'event', handler: (event: AppEvent) => void): this
  on(name: 'eose' | 'close', handler: () => void): this
  on(name: 'event' | 'eose' | 'close', handler: ((event: AppEvent) => void) | (() => void)): this {
    if (name === 'event') this.eventHandlers.add(handler)
    else {
      const handlers = this.endHandlers.get(name) ?? new Set()
      handlers.add(handler as () => void)
      this.endHandlers.set(name, handlers)
    }
    return this
  }
  start(): void {
    if (this.handle || this.stopped) return
    const options = { cache: this.options.cacheUsage ?? 'cache-first' as RuntimeCacheMode,
      relays: this.options.relayUrls, sources: this.options.sources, localEcho: !this.options.skipOptimisticPublishEvent }
    this.handle = this.client.runtime.subscribe(this.filters, {
      onEvent: event => {
        const draft = new AppEvent(this.client, event)
        for (const handler of this.eventHandlers) handler(draft)
      },
      onEose: () => {
        for (const handler of this.endHandlers.get('eose') ?? []) handler()
        if (this.options.closeOnEose) this.stop()
      },
      onError: error => console.warn('[nostr] Subscription unavailable:', error.message),
    }, options)
  }
  stop() {
    if (this.stopped) return
    this.stopped = true
    this.handle?.close()
    for (const handler of this.endHandlers.get('close') ?? []) handler()
    this.eventHandlers.clear()
    this.endHandlers.clear()
  }
}

export default class NostrClient {
  signer?: Signer
  readonly runtime: NostrWorkerClient
  readonly pool = {
    connectedRelays: () => this.runtime.getRelayStats().filter(relay => relay.connected),
  }
  constructor(options: { explicitRelayUrls?: string[] } = {}) {
    this.runtime = new NostrWorkerClient(async event => {
      if (!this.signer) throw new Error('Not logged in')
      return this.signer.signEvent(event)
    })
    if (options.explicitRelayUrls) this.runtime.setRelays(options.explicitRelayUrls)
  }
  setRelays(relays: string[]) { this.runtime.setRelays(relays) }
  subscribe(filter: Filter | Filter[], options: SubscriptionOptions = {}, autoStart = true) {
    const subscription = new EventSubscription(this, Array.isArray(filter) ? filter : [filter], options)
    if (autoStart) queueMicrotask(() => subscription.start())
    return subscription
  }
  async fetchEvents(filter: Filter | Filter[], options: SubscriptionOptions = {}) {
    const result = await this.runtime.query(Array.isArray(filter) ? filter : [filter], {
      cache: options.cacheUsage ?? 'cache-first', relays: options.relayUrls, sources: options.sources, localEcho: !options.skipOptimisticPublishEvent,
    })
    if (!result.complete && result.events.length === 0) throw new Error(`Message history unavailable: ${result.reason}`)
    return new Set(result.events.map(event => new AppEvent(this, event)))
  }
  getUser({pubkey}: {pubkey: string}) {
    const client = this
    return { pubkey, profile: {} as Record<string, unknown>,
      async publish() { return new AppEvent(client, {kind: 0, content: JSON.stringify(this.profile)}).publish() } }
  }
}
export { NostrClient }

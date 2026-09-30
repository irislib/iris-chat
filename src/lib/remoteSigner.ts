import { finalizeEvent, generateSecretKey, getPublicKey, nip44, verifyEvent, type Event, type UnsignedEvent } from 'nostr-tools'
import type { NostrRuntime, RuntimeSubscription } from 'nostr-pubsub'
export type SignerRuntime = Pick<NostrRuntime, 'subscribe' | 'publish' | 'query'>

const HEX_KEY = /^[a-f0-9]{64}$/
const TIMEOUT = 120_000
const MAX_MESSAGE = 64 * 1024

export function signerRelayUrls(values: string[]): string[] {
  const urls = [...new Set(values.map(value => {
    const url = new URL(value)
    if (!['wss:', 'ws:'].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new Error('Invalid signer message server.')
    }
    return url.toString()
  }))]
  if (!urls.length || urls.length > 8) throw new Error('Invalid signer message servers.')
  return urls
}

export function parseBunkerLink(value: string) {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('Paste a signer link to continue.') }
  if (url.protocol !== 'bunker:' || !HEX_KEY.test(url.hostname) || (url.pathname && url.pathname !== '/') || url.username || url.password || url.port || url.hash) {
    throw new Error('Invalid signer link.')
  }
  return { pubkey: url.hostname, relays: signerRelayUrls(url.searchParams.getAll('relay')), secret: url.searchParams.get('secret') || '' }
}

export interface RemoteSignerOptions {
  relays: string[]
  runtime: SignerRuntime
  bunkerLink?: string
  signal: AbortSignal
  onConnectionLink?: (link: string) => void
  onAuthUrl?: (url: string) => void
  timeoutMs?: number
}

type Pending = { method?: string; resolve: (value: string) => void; reject: (error: Error) => void }

/** An ephemeral signing channel. Its key is never an account or device key. */
export class RemoteSigner {
  private key = generateSecretKey()
  private publicKey = getPublicKey(this.key)
  private remoteKey = ''
  private relays: string[] = []
  private subscription?: RuntimeSubscription
  private pending = new Map<string, Pending>()
  private seen = new Set<string>()
  private closed = false
  private error = new Error('Sign-in cancelled.')
  private timer: ReturnType<typeof setTimeout>
  private challenge = crypto.randomUUID().replaceAll('-', '')
  private waitingConnection?: Pending
  private abort = () => this.close(new Error('Sign-in cancelled.'))

  constructor(private options: RemoteSignerOptions) {
    this.timer = setTimeout(() => this.close(new Error('Sign-in timed out. Try again.')), options.timeoutMs ?? TIMEOUT)
    options.signal.addEventListener('abort', this.abort, { once: true })
    if (options.signal.aborted) this.abort()
  }

  ensureActive() { if (this.closed) throw this.error }

  private check() { this.ensureActive() }

  private async listen(urls: string[]) {
    this.check()
    this.subscription?.close()
    this.relays = urls
    this.subscription = this.options.runtime.subscribe([{
      kinds: [24133], '#p': [this.publicKey], since: Math.floor(Date.now() / 1000) - 60,
    }], { onEvent: event => this.receive(event) }, {
      relays: urls, sources: [], cache: 'network-only', localEcho: false,
      signal: this.options.signal,
    })
  }

  async connect(): Promise<string> {
    const bunker = this.options.bunkerLink ? parseBunkerLink(this.options.bunkerLink) : null
    if (bunker) this.remoteKey = bunker.pubkey
    await this.listen(bunker?.relays ?? signerRelayUrls(this.options.relays))
    if (bunker) {
      const result = await this.request('connect', [bunker.pubkey, bunker.secret, 'sign_event:37368', JSON.stringify({ name: 'Iris Chat', url: 'https://chat.iris.to' })])
      if (result !== 'ack' && (!bunker.secret || result !== bunker.secret)) throw new Error('Invalid signer confirmation.')
    } else {
      const connected = new Promise<string>((resolve, reject) => { this.waitingConnection = { resolve, reject } })
      const link = new URL(`nostrconnect://${this.publicKey}`)
      for (const relay of this.relays) link.searchParams.append('relay', relay)
      link.searchParams.set('secret', this.challenge)
      link.searchParams.set('perms', 'sign_event:37368')
      link.searchParams.set('name', 'Iris Chat')
      link.searchParams.set('url', 'https://chat.iris.to')
      // Amber treats a literal '+' as a plus, rather than a query-space.
      this.options.onConnectionLink?.(link.toString().replaceAll('+', '%20'))
      await connected
    }
    this.check()
    // Older signers may explicitly reject this newly optional command.
    const switched = await this.request('switch_relays', [], 3000).catch(error => {
      this.check()
      if ((error instanceof SignerDeniedError && error.unsupported) || error instanceof SignerRequestTimeout) return 'null'
      throw error
    })
    if (switched !== 'null') {
      let urls: unknown
      try { urls = JSON.parse(switched) } catch { throw new Error('Invalid signer message servers.') }
      if (!Array.isArray(urls) || !urls.every(url => typeof url === 'string')) throw new Error('Invalid signer message servers.')
      await this.listen(signerRelayUrls(urls))
    }
    const owner = await this.request('get_public_key', [])
    if (!HEX_KEY.test(owner)) throw new Error('Invalid user ID from signer.')
    return owner
  }

  async signEvent(event: UnsignedEvent): Promise<Event> {
    const response = await this.request('sign_event', [JSON.stringify(event)])
    if (response.length > 32 * 1024) throw new Error('Invalid signer response.')
    try { return JSON.parse(response) as Event } catch { throw new Error('Invalid signer response.') }
  }

  private request(method: string, params: string[], timeoutMs = 90_000): Promise<string> {
    this.check()
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new SignerRequestTimeout('Sign-in timed out. Try again.'))
      }, timeoutMs)
      const fail = (error: Error) => { clearTimeout(timer); this.pending.delete(id); reject(error) }
      this.pending.set(id, {
        method,
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: fail,
      })
      try {
        const conversationKey = nip44.v2.utils.getConversationKey(this.key, this.remoteKey)
        const event = finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [['p', this.remoteKey]], content: nip44.v2.encrypt(JSON.stringify({ id, method, params }), conversationKey) }, this.key)
        this.options.runtime.publish(event, { relays: this.relays, sources: [], requireAck: true, queue: false, localEcho: false }).then(result => {
          if (!result.remoteAccepted) throw new Error('Signer request was not accepted')
        }).catch(() => {
          if (this.pending.has(id)) fail(new Error('Could not reach signer. Try again.'))
        })
      } catch { fail(new Error('Invalid signer connection.')) }
    })
  }

  private receive(raw: Event) {
    // Common-runtime events are immutable; never inherit a public verified marker.
    const event = { id: raw.id, pubkey: raw.pubkey, sig: raw.sig, kind: raw.kind,
      created_at: raw.created_at, content: raw.content, tags: raw.tags.map(tag => [...tag]) }
    if (this.closed || this.seen.has(event.id) || event.kind !== 24133 || event.content.length > MAX_MESSAGE || !event.tags.some(tag => tag[0] === 'p' && tag[1] === this.publicKey) || !verifyEvent(event)) return
    if (this.remoteKey && event.pubkey !== this.remoteKey) return
    try {
      const plaintext = nip44.v2.decrypt(event.content, nip44.v2.utils.getConversationKey(this.key, event.pubkey))
      const response = JSON.parse(plaintext) as { id?: unknown; result?: unknown; error?: unknown }
      if (typeof response.id !== 'string') return
      if (!this.remoteKey) {
        if (!this.waitingConnection || response.result !== this.challenge || response.error) return
        this.remoteKey = event.pubkey
        this.seen.add(event.id)
        this.waitingConnection.resolve(this.remoteKey)
        this.waitingConnection = undefined
        return
      }
      const pending = this.pending.get(response.id)
      if (!pending) return
      this.seen.add(event.id)
      if (response.result === 'auth_url') {
        const url = new URL(String(response.error))
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid signer approval link.')
        this.options.onAuthUrl?.(url.toString())
        return
      }
      this.pending.delete(response.id)
      if (response.error) pending.reject(new SignerDeniedError(/unknown method|unsupported|not supported|not implemented|method not found/i.test(String(response.error))))
      else if (pending.method === 'switch_relays' && (response.result === null || Array.isArray(response.result))) pending.resolve(JSON.stringify(response.result))
      else if (typeof response.result !== 'string') pending.reject(new Error('Invalid signer response.'))
      else pending.resolve(response.result)
    } catch {
      // Unauthenticated/malformed relay traffic cannot change a pending request.
    }
  }

  close(error = new Error('Sign-in cancelled.')) {
    if (this.closed) return
    this.closed = true
    this.error = error
    clearTimeout(this.timer)
    this.options.signal.removeEventListener('abort', this.abort)
    this.waitingConnection?.reject(error)
    this.waitingConnection = undefined
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.subscription?.close()
    this.key.fill(0)
  }
}

class SignerDeniedError extends Error {
  constructor(readonly unsupported: boolean) { super('Signer declined the request. Try again.') }
}
class SignerRequestTimeout extends Error {}

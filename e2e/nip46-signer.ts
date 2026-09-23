import { WebSocket } from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey, nip44, verifyEvent, type Event, type UnsignedEvent } from 'nostr-tools'

/** Test signer owns its identity secret in this separate Node process/context. */
export class TestRemoteSigner {
  readonly ownerSecret = generateSecretKey()
  readonly ownerPubkey = getPublicKey(this.ownerSecret)
  private transportSecret = generateSecretKey()
  readonly transportPubkey = getPublicKey(this.transportSecret)
  readonly secret = crypto.randomUUID()
  requests: string[] = []
  signedEvents: Event[] = []
  denySigning = false
  mutateSigning = false
  holdSigning = false
  ignoreSwitchRelays = false
  switchRelaysResult: unknown = null
  switchRelaysError?: string
  authUrl: string | null = null
  beforeSign?: () => Promise<void>
  private socket?: WebSocket
  private processed = new Set<string>()
  private pending: { client: string; id: string; event: UnsignedEvent }[] = []
  constructor(readonly relayUrl: string) {}

  get bunkerLink() {
    const link = new URL(`bunker://${this.transportPubkey}`)
    link.searchParams.set('relay', this.relayUrl)
    link.searchParams.set('secret', this.secret)
    return link.toString()
  }

  async start() {
    this.socket = new WebSocket(this.relayUrl)
    await new Promise<void>((resolve, reject) => { this.socket!.once('open', resolve); this.socket!.once('error', reject) })
    this.socket.on('message', data => {
      const message = JSON.parse(data.toString())
      if (message[0] === 'EVENT') void this.receive(message[2])
    })
    this.socket.send(JSON.stringify(['REQ', 'signer', { kinds: [24133], '#p': [this.transportPubkey] }]))
  }

  async acceptConnection(link: string, secretOverride?: string) {
    const url = new URL(link)
    if (url.protocol !== 'nostrconnect:') throw new Error('Expected nostrconnect link')
    await this.respond(url.hostname, crypto.randomUUID(), secretOverride ?? url.searchParams.get('secret')!)
  }

  async publish(event: Event) {
    const socket = this.socket!
    const acknowledged = new Promise<void>((resolve, reject) => {
      const listener = (data: { toString(): string }) => {
        const message = JSON.parse(data.toString())
        if (message[0] !== 'OK' || message[1] !== event.id) return
        socket.off('message', listener)
        if (message[2]) resolve(); else reject(new Error('Relay rejected event'))
      }
      socket.on('message', listener)
    })
    socket.send(JSON.stringify(['EVENT', event]))
    await acknowledged
  }

  private async respond(client: string, id: string, result: unknown, error?: string) {
    const content = nip44.v2.encrypt(JSON.stringify({ id, result, ...(error ? { error } : {}) }), nip44.v2.utils.getConversationKey(this.transportSecret, client))
    await this.publish(finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [['p', client]], content }, this.transportSecret))
  }

  private async receive(event: Event) {
    if (!verifyEvent(event) || this.processed.has(event.id)) return
    this.processed.add(event.id)
    const request = JSON.parse(nip44.v2.decrypt(event.content, nip44.v2.utils.getConversationKey(this.transportSecret, event.pubkey))) as { id: string; method: string; params: string[] }
    this.requests.push(request.method)
    switch (request.method) {
      case 'connect':
        await this.respond(event.pubkey, request.id, request.params[1] === this.secret ? 'ack' : '', request.params[1] !== this.secret ? 'Invalid secret' : undefined)
        break
      case 'switch_relays': if (!this.ignoreSwitchRelays) await this.respond(event.pubkey, request.id, this.switchRelaysResult, this.switchRelaysError); break
      case 'get_public_key': await this.respond(event.pubkey, request.id, this.ownerPubkey); break
      case 'sign_event': {
        const pending = { client: event.pubkey, id: request.id, event: JSON.parse(request.params[0]) as UnsignedEvent }
        if (this.authUrl) await this.respond(event.pubkey, request.id, 'auth_url', this.authUrl)
        if (this.holdSigning) this.pending.push(pending)
        else await this.sign(pending)
        break
      }
      default: await this.respond(event.pubkey, request.id, '', 'Unsupported method')
    }
  }

  private async sign(request: { client: string; id: string; event: UnsignedEvent }) {
    await this.beforeSign?.()
    if (this.denySigning) return this.respond(request.client, request.id, '', 'Denied')
    const event = finalizeEvent({ ...request.event, ...(this.mutateSigning ? { content: 'changed' } : {}) }, this.ownerSecret)
    this.signedEvents.push(event)
    await this.respond(request.client, request.id, JSON.stringify(event))
  }

  async releaseSigning() {
    for (const pending of this.pending.splice(0)) await this.sign(pending)
  }

  async stop() {
    const socket = this.socket
    if (!socket || socket.readyState === WebSocket.CLOSED) return
    await new Promise<void>(resolve => { socket.once('close', resolve); socket.close() })
  }
}

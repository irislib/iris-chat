/**
 * Minimal NIP-01 Nostr relay for e2e tests.
 * Stores events in memory, supports REQ/EVENT/CLOSE.
 * Each test gets a fresh relay instance on a random port.
 */

import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'net'
import * as http from 'http'

interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

interface Filter {
  ids?: string[]
  authors?: string[]
  kinds?: number[]
  '#e'?: string[]
  '#p'?: string[]
  since?: number
  until?: number
  limit?: number
  [key: string]: unknown
}

export class TestRelay {
  private server: http.Server
  private wss: WebSocketServer
  private events: Map<string, NostrEvent> = new Map()
  private eventsByAuthor = new Map<string, Set<string>>()
  private eventsByRecipient = new Map<string, Set<string>>()
  private eventOrder = new Map<string, number>()
  private subscriptions: Map<WebSocket, Map<string, Filter[]>> = new Map()
  public port: number = 0
  public deliveryFilter?: (event: NostrEvent) => boolean
  public acceptFilter?: (event: NostrEvent) => boolean
  public observeRequest?: (filters: Filter[], browser: boolean) => void
  public deliveredEvents = 0
  public replayedEvents = 0
  public liveEvents = 0
  private browsers = new WeakSet<WebSocket>()

  constructor() {
    this.server = http.createServer()
    this.wss = new WebSocketServer({ server: this.server })

    this.wss.on('connection', (ws, request) => {
      if (request.headers['user-agent']?.includes('Mozilla/')) this.browsers.add(ws)
      this.subscriptions.set(ws, new Map())

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString())
          this.handleMessage(ws, msg)
        } catch {
          // ignore malformed
        }
      })

      ws.on('close', () => {
        this.subscriptions.delete(ws)
      })

      ws.on('error', (err) => {
        console.error(`[relay:${this.port}] ws error:`, err.message)
      })
    })

    this.wss.on('error', (err) => {
      console.error(`[relay] wss error:`, err.message)
    })
  }

  private handleMessage(ws: WebSocket, msg: unknown[]) {
    const type = msg[0]

    if (type === 'EVENT') {
      const event = msg[1] as NostrEvent
      if (this.acceptFilter && !this.acceptFilter(event)) {
        ws.send(JSON.stringify(['OK', event.id, false, 'blocked: event kind not supported']))
        return
      }
      // Store event (no signature verification for tests)
      const previous = this.events.get(event.id)
      if (previous) this.indexEvent(previous, false)
      else this.eventOrder.set(event.id, this.eventOrder.size)
      this.events.set(event.id, event)
      this.indexEvent(event, true)
      // Send OK
      ws.send(JSON.stringify(['OK', event.id, true, '']))
      // Broadcast to matching subscriptions
      this.broadcastEvent(event, ws)
    } else if (type === 'REQ') {
      const subId = msg[1] as string
      const filters = msg.slice(2) as Filter[]
      this.observeRequest?.(filters, this.browsers.has(ws))
      // Store subscription
      const subs = this.subscriptions.get(ws)
      if (subs) {
        subs.set(subId, filters)
      }
      // Send matching stored events
      let sent = 0
      for (const event of this.historyCandidates(filters)) {
        if (this.matchesFilters(event, filters)) {
          ws.send(JSON.stringify(['EVENT', subId, event]))
          this.deliveredEvents++
          this.replayedEvents++
          sent++
        }
      }
      // Send EOSE
      ws.send(JSON.stringify(['EOSE', subId]))
      if (this.debug) {
        const summarize = (f: Filter) => {
          const kinds = Array.isArray(f.kinds) ? f.kinds.join(',') : '-'
          const authors = Array.isArray(f.authors) ? f.authors.map((a) => a.slice(0, 8)).join(',') : '-'
          const p = Array.isArray((f as any)['#p']) ? (f as any)['#p'].map((a: string) => a.slice(0, 8)).join(',') : '-'
          const d = Array.isArray((f as any)['#d']) ? (f as any)['#d'].join(',') : '-'
          const l = Array.isArray((f as any)['#l']) ? (f as any)['#l'].join(',') : '-'
          return `kinds=${kinds} authors=${authors} #p=${p} #d=${d} #l=${l}`
        }
        console.log(
          `[relay:${this.port}] REQ ${subId} (${filters.length} filters) sent=${sent} ` +
            filters.map(summarize).join(' | ')
        )
      }
    } else if (type === 'CLOSE') {
      const subId = msg[1] as string
      const subs = this.subscriptions.get(ws)
      if (subs) {
        subs.delete(subId)
      }
      ws.send(JSON.stringify(['CLOSED', subId, '']))
    }
  }

  private broadcastEvent(event: NostrEvent, sender?: WebSocket) {
    let matched = 0
    for (const [ws, subs] of this.subscriptions) {
      if (ws.readyState !== WebSocket.OPEN) continue
      for (const [subId, filters] of subs) {
        if (this.matchesFilters(event, filters)) {
          ws.send(JSON.stringify(['EVENT', subId, event]))
          this.deliveredEvents++
          this.liveEvents++
          matched++
        }
      }
    }
    if (this.debug) {
      const dTag = event.tags.find(t => t[0] === 'd')?.[1]
      const lTag = event.tags.find(t => t[0] === 'l')?.[1]
      const pTag = event.tags.find(t => t[0] === 'p')?.[1]
      const deviceTags = event.tags
        .filter((t) => t[0] === 'device')
        .map((t) => t[1]?.slice(0, 8))
        .filter(Boolean)
      console.log(
        `[relay:${this.port}] broadcast kind=${event.kind}` +
          ` pubkey=${event.pubkey.slice(0, 8)}` +
          ` d=${dTag ?? '-'}` +
          ` l=${lTag ?? '-'}` +
          ` p=${pTag ? pTag.slice(0, 8) : '-'}` +
          ` devices=${deviceTags.length > 0 ? deviceTags.join(',') : '-'}` +
          ` id=${event.id.slice(0, 8)}` +
          ` → ${matched} subscribers (${this.subscriptions.size} clients)`
      )
    }
  }

  public debug = false

  private indexEvent(event: NostrEvent, add: boolean) {
    const entries: Array<[Map<string, Set<string>>, string[]]> = [
      [this.eventsByAuthor, [event.pubkey]],
      [this.eventsByRecipient, event.tags.filter((tag) => tag[0] === 'p').map((tag) => tag[1])],
    ]
    for (const [index, keys] of entries) for (const key of keys) {
      if (add) {
        let ids = index.get(key)
        if (!ids) index.set(key, ids = new Set())
        ids.add(event.id)
      } else {
        const ids = index.get(key)
        ids?.delete(event.id)
        if (!ids?.size) index.delete(key)
      }
    }
  }

  private historyCandidates(filters: Filter[]): Iterable<NostrEvent> {
    // Real relays index these fields. Avoid making the test's single relay
    // scan its entire history for every one of the simulated clients' REQs.
    // The original matcher still verifies all constraints and delivery hooks.
    const candidates = new Set<string>()
    for (const filter of filters) {
      const choices: Array<{ keys: string[]; index?: Map<string, Set<string>> }> = []
      if (filter.ids) choices.push({ keys: filter.ids })
      if (filter.authors) choices.push({ keys: filter.authors, index: this.eventsByAuthor })
      if (filter['#p']) choices.push({ keys: filter['#p'], index: this.eventsByRecipient })
      if (!choices.length) return this.events.values()
      const cost = ({ keys, index }: typeof choices[number]) => index
        ? keys.reduce((sum, key) => sum + (index.get(key)?.size ?? 0), 0) : keys.length
      choices.sort((left, right) => cost(left) - cost(right))
      const { keys, index } = choices[0]!
      for (const key of keys) {
        if (index) {
          for (const id of index.get(key) ?? []) candidates.add(id)
        } else if (this.events.has(key)) candidates.add(key)
      }
    }
    return [...candidates].sort((left, right) => this.eventOrder.get(left)! - this.eventOrder.get(right)!)
      .map((id) => this.events.get(id)!)
  }

  private matchesFilters(event: NostrEvent, filters: Filter[]): boolean {
    if (this.deliveryFilter && !this.deliveryFilter(event)) return false
    return filters.some(f => this.matchesFilter(event, f))
  }

  private matchesFilter(event: NostrEvent, filter: Filter): boolean {
    if (filter.ids && !filter.ids.includes(event.id)) return false
    if (filter.authors && !filter.authors.includes(event.pubkey)) return false
    if (filter.kinds && !filter.kinds.includes(event.kind)) return false
    if (filter.since && event.created_at < filter.since) return false
    if (filter.until && event.created_at > filter.until) return false

    // Check tag filters (#e, #p, etc.)
    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith('#') && Array.isArray(values)) {
        const tagName = key.slice(1)
        const eventTagValues = event.tags
          .filter(t => t[0] === tagName)
          .map(t => t[1])
        if (!values.some(v => eventTagValues.includes(v))) return false
      }
    }

    return true
  }

  async start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as AddressInfo).port
        resolve(this.port)
      })
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      // Close all connections
      for (const ws of this.wss.clients) {
        ws.close()
      }
      this.wss.close(() => {
        this.server.close(() => {
          resolve()
        })
      })
    })
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`
  }

  get publishedEvents(): NostrEvent[] {
    return Array.from(this.events.values())
  }

  /** Clear all stored events */
  clear() {
    this.events.clear()
    this.eventsByAuthor.clear()
    this.eventsByRecipient.clear()
    this.eventOrder.clear()
  }
}

/**
 * WebSocket relay stub that accepts connections but never responds to any
 * Nostr traffic. Used to verify clients tolerate a connected-but-deaf relay
 * in multi-client interop tests.
 */
export class SilentTestRelay {
  private server: http.Server
  private wss: WebSocketServer
  public port = 0
  public totalConnections = 0
  // Some scenarios require complete authorization history while deliberately
  // keeping message subscriptions stalled.
  public responsiveKinds = new Set<number>()

  constructor() {
    this.server = http.createServer()
    this.wss = new WebSocketServer({ server: this.server })

    this.wss.on('connection', (ws) => {
      this.totalConnections += 1

      ws.on('message', data => {
        if (!this.responsiveKinds.size) return
        try {
          const [command, id, ...filters] = JSON.parse(data.toString())
          if (command === 'REQ' && filters.length && filters.every((filter: { kinds?: number[] }) =>
            Array.isArray(filter.kinds) && filter.kinds.length && filter.kinds.every((kind: number) => this.responsiveKinds.has(kind)))) {
            ws.send(JSON.stringify(['EOSE', id]))
          } else if (command === 'EVENT' && this.responsiveKinds.has(id?.kind)) {
            ws.send(JSON.stringify(['OK', id.id, true, '']))
          }
        } catch { /* All other client traffic remains silent. */ }
      })

      ws.on('error', (err) => {
        console.error(`[silent-relay:${this.port}] ws error:`, err.message)
      })
    })

    this.wss.on('error', (err) => {
      console.error(`[silent-relay] wss error:`, err.message)
    })
  }

  async start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as AddressInfo).port
        resolve(this.port)
      })
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const ws of this.wss.clients) {
        ws.close()
      }
      this.wss.close(() => {
        this.server.close(() => {
          resolve()
        })
      })
    })
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`
  }
}

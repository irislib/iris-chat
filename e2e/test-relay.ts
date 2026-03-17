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
  private subscriptions: Map<WebSocket, Map<string, Filter[]>> = new Map()
  public port: number = 0

  constructor() {
    this.server = http.createServer()
    this.wss = new WebSocketServer({ server: this.server })

    this.wss.on('connection', (ws) => {
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
      // Store event (no signature verification for tests)
      this.events.set(event.id, event)
      // Send OK
      ws.send(JSON.stringify(['OK', event.id, true, '']))
      // Broadcast to matching subscriptions
      this.broadcastEvent(event, ws)
    } else if (type === 'REQ') {
      const subId = msg[1] as string
      const filters = msg.slice(2) as Filter[]
      // Store subscription
      const subs = this.subscriptions.get(ws)
      if (subs) {
        subs.set(subId, filters)
      }
      // Send matching stored events
      let sent = 0
      for (const event of this.events.values()) {
        if (this.matchesFilters(event, filters)) {
          ws.send(JSON.stringify(['EVENT', subId, event]))
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

  private matchesFilters(event: NostrEvent, filters: Filter[]): boolean {
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
  }
}

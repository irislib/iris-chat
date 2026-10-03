import { Reconciliation } from 'nostr-pubsub-reconcile'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { deviceSyncPacketByteLength, DEVICE_SYNC_MAX_PACKET_BYTES, type DeviceHistoryPacket, type DeviceSyncMessage } from './deviceSyncProtocol'

export type HistoryRecord = Pick<DeviceSyncMessage, 'chatId' | 'id' | 'createdAt'>
export const historyRecordId = (message: Pick<HistoryRecord, 'chatId' | 'id'>): string =>
  bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([message.chatId, message.id]))))

interface HistorySession {
  id: string
  linkId?: string
  since: number
  until: number
  expires: number
  engine: Reconciliation
  records: Map<string, HistoryRecord>
  initiator: boolean
  pending: string[]
  requested: Set<string>
  received: Set<string>
  complete: boolean
  restartSince?: number
  imported: number
  total: number
  withheld: boolean
}

interface HistoryPeer {
  floor: number
  incoming?: HistorySession
  outgoing?: HistorySession
}

/** One pull in each direction, carried by the existing authenticated device stream.
 * Inventory completion never acknowledges a message before durable admission. */
export class DeviceHistorySync {
  private peers = new Map<string, HistoryPeer>()
  private queues = new Map<string, Promise<void>>()
  constructor(private options: {
    authorized(peer: string): boolean
    floor?(peer: string): number
    allowsWindow?(peer: string, since: number, until: number, linkId?: string): boolean
    inventory(since: number, until: number, initiator: boolean): Promise<HistoryRecord[]>
    messages(since: number, until: number, requested: HistoryRecord[]): Promise<DeviceSyncMessage[]>
    apply(messages: DeviceSyncMessage[], since: number, authorized: () => boolean): Promise<number | void>
    progress?(peer: string, since: number, imported: number, total?: number): void
    complete?(peer: string, since: number, until: number, withheld: boolean): Promise<void>
    fallback?(peer: string, since: number, until: number): Promise<void>
    send(peer: string, packet: DeviceHistoryPacket): Promise<void>
    now?: () => number
  }) {}

  reset(peer?: string): void {
    if (peer) this.peers.delete(peer)
    else this.peers.clear()
  }

  negotiate(peer: string, floor: number): void {
    const state = this.peers.get(peer)
    if (state) state.floor = floor
    else if (this.peers.size < 32) this.peers.set(peer, { floor })
  }

  start(peer: string, since: number, end?: number, linkId?: string): Promise<void> {
    return this.queue(peer, async () => {
      if (!this.options.authorized(peer)) return
      let state = this.peers.get(peer)
      if (!state) {
        if (this.peers.size >= 32) return
        state = { floor: Infinity }; this.peers.set(peer, state)
      }
      if (state.outgoing && this.live(peer, state, state.outgoing)) { state.outgoing.restartSince = since; return }
      const until = end ?? Math.max(since, Math.floor(this.now() / 1000))
      let session: HistorySession
      try { session = await this.session(bytesToHex(crypto.getRandomValues(new Uint8Array(16))), since, until, true) }
      catch (error) {
        if (!(error instanceof Error) || !error.message.includes('record limit')) throw error
        await this.options.fallback?.(peer, since, until)
        return
      }
      if (!this.valid(peer, state)) return
      state.outgoing = session
      session.linkId = linkId
      this.options.progress?.(peer, since, 0)
      await this.send(peer, state, session, { v: 1, type: 'historyOpen', session: session.id, since, until, ...(linkId && { linkId }),
        frame: bytesToHex(await session.engine.initiate()) })
    })
  }

  receive(peer: string, packet: DeviceHistoryPacket): Promise<void> {
    return this.queue(peer, async () => {
      const state = this.peers.get(peer)
      if (!state || !this.valid(peer, state)) return
      if (packet.type === 'historyOpen') {
        if (packet.since < Math.max(state.floor, this.options.floor?.(peer) ?? 0) || packet.until > Math.floor(this.now() / 1000) + 300 || packet.session === state.outgoing?.id ||
          this.options.allowsWindow?.(peer, packet.since, packet.until, packet.linkId) === false) return
        if (state.incoming && this.live(peer, state, state.incoming)) return
        let session: HistorySession
        try { session = await this.session(packet.session, packet.since, packet.until, false) }
        catch (error) {
          if (!(error instanceof Error) || !error.message.includes('record limit')) throw error
          if (this.valid(peer, state)) await this.options.send(peer, { v: 1, type: 'historyDone', session: packet.session })
          return
        }
        if (!this.valid(peer, state)) return
        state.incoming = session
        session.linkId = packet.linkId
        await this.send(peer, state, session, { v: 1, type: 'historyFrame', session: session.id,
          frame: bytesToHex(await session.engine.respond(hexToBytes(packet.frame))) })
        return
      }
      const session = [state.incoming, state.outgoing].find(session => session?.id === packet.session)
      if (!session || !this.live(peer, state, session)) return
      if (packet.type === 'historyDone') {
        if (!session.initiator) state.incoming = undefined
        else {
          state.outgoing = undefined
          await this.options.fallback?.(peer, session.since, session.until)
        }
        return
      }
      if (packet.type === 'historyFrame') {
        if (!session.initiator) {
          await this.send(peer, state, session, { v: 1, type: 'historyFrame', session: session.id,
            frame: bytesToHex(await session.engine.respond(hexToBytes(packet.frame))) })
        } else {
          const step = await session.engine.reconcile(hexToBytes(packet.frame))
          session.pending.push(...step.need.map(bytesToHex))
          session.total += step.need.length
          if (session.pending.length > 100_000) throw new Error('history demand limit exceeded')
          session.complete = !step.next
          this.options.progress?.(peer, session.since, session.imported, session.complete ? session.total : undefined)
          if (step.next) await this.send(peer, state, session, { v: 1, type: 'historyFrame', session: session.id, frame: bytesToHex(step.next) })
          await this.requestNext(peer, state, session)
        }
      } else if (packet.type === 'historyNeed' && !session.initiator) {
        const requested = new Set(packet.ids)
        if (packet.ids.some(id => !session.records.has(id) || session.received.has(id))) throw new Error('history request is outside the inventory or repeated')
        packet.ids.forEach(id => session.received.add(id))
        // Re-read current data: removals, expiry and policy changes win over the snapshot.
        const messages = await this.options.messages(session.since, session.until, packet.ids.map(id => session.records.get(id)!))
        let batch: DeviceSyncMessage[] = []
        for (const message of messages) {
          if (!requested.has(historyRecordId(message))) continue
          const candidate: DeviceHistoryPacket = { v: 1, type: 'historyMessages', session: session.id, messages: [...batch, message], requested: [] }
          if (deviceSyncPacketByteLength(candidate) > DEVICE_SYNC_MAX_PACKET_BYTES) {
            if (batch.length) await this.send(peer, state, session, { ...candidate, messages: batch })
            batch = []
          }
          if (deviceSyncPacketByteLength({ ...candidate, messages: [message] }) <= DEVICE_SYNC_MAX_PACKET_BYTES) batch.push(message)
        }
        if (batch.length) await this.send(peer, state, session, { v: 1, type: 'historyMessages', session: session.id, messages: batch, requested: [] })
        await this.send(peer, state, session, { v: 1, type: 'historyMessages', session: session.id, messages: [], requested: packet.ids })
      } else if (packet.type === 'historyMessages' && session.initiator) {
        const ids = packet.messages.map(historyRecordId)
        if (packet.messages.some((message, index) => message.createdAt < session.since || message.createdAt > session.until ||
          !session.requested.has(ids[index]) || session.received.has(ids[index])) || new Set(ids).size !== ids.length ||
          packet.requested.some(id => !session.requested.has(id))) throw new Error('unsolicited history message')
        const imported = await this.options.apply(packet.messages, session.since, () => this.live(peer, state, session))
        if (!this.live(peer, state, session)) return
        ids.forEach(id => session.received.add(id))
        session.imported += imported ?? packet.messages.length
        if (packet.requested.some(id => !session.received.has(id))) session.withheld = true
        packet.requested.forEach(id => session.requested.delete(id))
        if (packet.requested.length) this.options.progress?.(peer, session.since, session.imported, session.complete ? session.total : undefined)
        await this.requestNext(peer, state, session)
      }
    })
  }

  private async requestNext(peer: string, state: HistoryPeer, session: HistorySession): Promise<void> {
    if (session.requested.size) return
    session.received.clear()
    const ids = session.pending.splice(0, 32)
    if (ids.length) {
      ids.forEach(id => session.requested.add(id))
      await this.send(peer, state, session, { v: 1, type: 'historyNeed', session: session.id, ids })
    } else if (session.complete) {
      await this.send(peer, state, session, { v: 1, type: 'historyDone', session: session.id })
      state.outgoing = undefined
      await this.options.complete?.(peer, session.since, session.until, session.withheld)
      if (session.restartSince !== undefined && session.since > 0) void this.start(peer, session.restartSince).catch(() => undefined)
    }
  }

  private async session(id: string, since: number, until: number, initiator: boolean): Promise<HistorySession> {
    const inventory = await this.options.inventory(since, until, initiator)
    const records = new Map(inventory.filter(item => item.createdAt >= since && item.createdAt <= until)
      .map(item => [historyRecordId(item), { chatId: item.chatId, id: item.id, createdAt: item.createdAt }]))
    const retained = [...this.peers.values()].flatMap(peer => [peer.incoming, peer.outgoing])
      .reduce((total, session) => total + (session?.records.size ?? 0), 0)
    if (records.size + retained > 200_000) throw new Error('reconciliation window exceeds record limit')
    return { id, since, until, initiator, expires: this.now() + 120_000,
      engine: new Reconciliation([...records].map(([id, message]) => ({ id: hexToBytes(id), timestamp: BigInt(message.createdAt) })),
        { since: BigInt(since), until: BigInt(until) }),
      records, pending: [], requested: new Set(), received: new Set(), complete: false, imported: 0, total: 0, withheld: false }
  }
  private now(): number { return this.options.now?.() ?? Date.now() }
  private valid(peer: string, state: HistoryPeer): boolean { return this.peers.get(peer) === state && this.options.authorized(peer) }
  private live(peer: string, state: HistoryPeer, session: HistorySession): boolean {
    return this.valid(peer, state) && session.expires > this.now() &&
      (session.initiator || (session.since >= Math.max(state.floor, this.options.floor?.(peer) ?? 0) &&
        this.options.allowsWindow?.(peer, session.since, session.until, session.linkId) !== false))
  }
  private async send(peer: string, state: HistoryPeer, session: HistorySession, packet: DeviceHistoryPacket): Promise<void> {
    if (this.live(peer, state, session)) await this.options.send(peer, packet)
  }
  private queue(peer: string, operation: () => Promise<void>): Promise<void> {
    const queued = (this.queues.get(peer) ?? Promise.resolve()).catch(() => undefined).then(operation)
      .catch(error => { this.reset(peer); throw error })
    this.queues.set(peer, queued)
    void queued.finally(() => { if (this.queues.get(peer) === queued) this.queues.delete(peer) }).catch(() => undefined)
    return queued
  }
}

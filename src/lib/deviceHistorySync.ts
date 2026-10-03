import { Reconciliation } from 'nostr-pubsub-reconcile'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { deviceSyncPacketByteLength, DEVICE_SYNC_MAX_PACKET_BYTES, type DeviceHistoryPacket, type DeviceSyncMessage } from './deviceSyncProtocol'
import { deviceSyncRecordId, deviceSyncRecordScope, deviceSyncRecordTime, type DeviceSyncRecord, type DeviceSyncScope } from './deviceSyncRecords'

export type HistoryRecord = Pick<DeviceSyncMessage, 'chatId' | 'id' | 'createdAt'>
export const historyRecordId = (message: Pick<HistoryRecord, 'chatId' | 'id'>): string =>
  bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([message.chatId, message.id]))))

interface HistorySession {
  id: string
  linkId?: string
  scope?: DeviceSyncScope
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
  restart?: { since: number; until?: number; linkId?: string }
  imported: number
  total: number
  withheld: boolean
}

interface HistoryPeer {
  floor: number
  typed?: boolean
  latest?: number
  incoming?: HistorySession
  outgoing?: HistorySession
  stateIncoming?: HistorySession
  stateOutgoing?: HistorySession
}

const slot = (initiator: boolean, scope?: DeviceSyncScope): 'incoming' | 'outgoing' | 'stateIncoming' | 'stateOutgoing' =>
  scope === 'state' ? initiator ? 'stateOutgoing' : 'stateIncoming' : initiator ? 'outgoing' : 'incoming'

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
    messages(since: number, until: number, requested: HistoryRecord[], peer?: string, linkId?: string): Promise<DeviceSyncMessage[]>
    apply(messages: DeviceSyncMessage[], since: number, authorized: () => boolean, peer?: string, until?: number, linkId?: string): Promise<number | void>
    recordInventory?(scope: DeviceSyncScope, since: number, until: number, initiator: boolean): Promise<Array<{ id: string; createdAt: number }>>
    records?(scope: DeviceSyncScope, since: number, until: number, ids: string[], peer: string, linkId?: string): Promise<DeviceSyncRecord[]>
    applyRecords?(peer: string, records: DeviceSyncRecord[], scope: DeviceSyncScope, since: number, until: number, linkId: string | undefined, authorized: () => boolean): Promise<number>
    progress?(peer: string, since: number, imported: number, total?: number): void
    complete?(peer: string, since: number, until: number, withheld: boolean): Promise<void>
    unavailable?(peer: string, since: number): void
    fallback?(peer: string, since: number, until: number): Promise<void>
    send(peer: string, packet: DeviceHistoryPacket): Promise<void>
    now?: () => number
  }) {}

  reset(peer?: string): void {
    if (peer) this.peers.delete(peer)
    else this.peers.clear()
  }

  negotiate(peer: string, floor: number, typed = false): void {
    const state = this.peers.get(peer)
    if (state) { state.floor = floor; state.typed ||= typed }
    else if (this.peers.size < 32) this.peers.set(peer, { floor, typed })
  }

  observe(peer: string, timestamps: Iterable<number>): void {
    if (!this.options.authorized(peer)) return
    if (!this.peers.has(peer)) this.negotiate(peer, Infinity)
    const state = this.peers.get(peer)
    if (!state) return
    const latestAllowed = Math.floor(this.now() / 1000) + 300
    for (const timestamp of timestamps) {
      if (Number.isSafeInteger(timestamp) && timestamp >= 0 && timestamp <= latestAllowed) {
        state.latest = Math.max(state.latest ?? 0, timestamp)
      }
    }
  }

  startState(peer: string): Promise<void> { return this.start(peer, 0, 0, undefined, 'state') }

  start(peer: string, since: number, end?: number, linkId?: string, requestedScope?: DeviceSyncScope): Promise<void> {
    return this.queue(peer, async () => {
      if (!this.options.authorized(peer)) return
      let state = this.peers.get(peer)
      if (!state) {
        if (this.peers.size >= 32) return
        state = { floor: Infinity }; this.peers.set(peer, state)
      }
      if (requestedScope === 'state' && (!state.typed || !this.options.recordInventory)) return
      const scope = requestedScope ?? (state.typed && this.options.recordInventory ? 'history' : undefined)
      const outgoing = state[slot(true, scope)]
      if (outgoing && this.live(peer, state, outgoing)) {
        // A pending initial transfer keeps its exact approval binding, even when
        // a later metadata update also asks for normal gap repair.
        if (!outgoing.restart?.linkId || linkId) outgoing.restart = { since, until: end, linkId }
        return
      }
      // A sibling's clock can lead ours. Its validated metadata may advertise a
      // just-sent message beyond local now, even when this is its only update.
      const until = end ?? Math.max(since, Math.floor(this.now() / 1000), state.latest ?? 0)
      let session: HistorySession
      try { session = await this.session(bytesToHex(crypto.getRandomValues(new Uint8Array(16))), since, until, true, scope) }
      catch (error) {
        if (!(error instanceof Error) || !error.message.includes('record limit')) throw error
        if (!scope) await this.options.fallback?.(peer, since, until)
        else if (scope === 'history') this.options.unavailable?.(peer, since)
        return
      }
      if (!this.valid(peer, state)) return
      state[slot(true, scope)] = session
      session.linkId = linkId
      if (scope !== 'state') this.options.progress?.(peer, since, 0)
      await this.send(peer, state, session, { v: 1, type: 'historyOpen', session: session.id, since, until, ...(linkId && { linkId }),
        ...(scope && { scope }), frame: bytesToHex(await session.engine.initiate()) })
    })
  }

  receive(peer: string, packet: DeviceHistoryPacket): Promise<void> {
    return this.queue(peer, async () => {
      const state = this.peers.get(peer)
      if (!state || !this.valid(peer, state)) return
      if (packet.type === 'historyOpen') {
        if (packet.scope && (!state.typed || !this.options.recordInventory)) return
        if (packet.scope !== 'state' && (packet.since < Math.max(state.floor, this.options.floor?.(peer) ?? 0) || packet.until > Math.floor(this.now() / 1000) + 300 ||
          this.options.allowsWindow?.(peer, packet.since, packet.until, packet.linkId) === false)) return
        if (packet.scope === 'state' && (packet.since !== 0 || packet.until !== 0 || packet.linkId)) return
        if ([state.outgoing, state.stateOutgoing].some(session => session?.id === packet.session)) return
        const incoming = state[slot(false, packet.scope)]
        if (incoming && this.live(peer, state, incoming)) return
        let session: HistorySession
        try { session = await this.session(packet.session, packet.since, packet.until, false, packet.scope) }
        catch (error) {
          if (!(error instanceof Error) || !error.message.includes('record limit')) throw error
          if (this.valid(peer, state)) await this.options.send(peer, { v: 1, type: 'historyDone', session: packet.session })
          return
        }
        if (!this.valid(peer, state)) return
        state[slot(false, packet.scope)] = session
        session.linkId = packet.linkId
        await this.send(peer, state, session, { v: 1, type: 'historyFrame', session: session.id,
          frame: bytesToHex(await session.engine.respond(hexToBytes(packet.frame))) })
        return
      }
      const session = [state.incoming, state.outgoing, state.stateIncoming, state.stateOutgoing].find(session => session?.id === packet.session)
      if (!session || !this.live(peer, state, session)) return
      if (packet.type === 'historyDone') {
        if (!session.initiator) state[slot(false, session.scope)] = undefined
        else {
          state[slot(true, session.scope)] = undefined
          if (!session.scope) await this.options.fallback?.(peer, session.since, session.until)
          else if (session.scope === 'history') this.options.unavailable?.(peer, session.since)
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
          if (session.scope !== 'state') this.options.progress?.(peer, session.since, session.imported, !session.scope && session.complete ? session.total : undefined)
          if (step.next) await this.send(peer, state, session, { v: 1, type: 'historyFrame', session: session.id, frame: bytesToHex(step.next) })
          await this.requestNext(peer, state, session)
        }
      } else if (packet.type === 'historyNeed' && !session.initiator) {
        const requested = new Set(packet.ids)
        if (new Set(packet.ids).size !== packet.ids.length || packet.ids.some(id => !session.records.has(id) || session.received.has(id))) throw new Error('history request is outside the inventory or repeated')
        packet.ids.forEach(id => session.received.add(id))
        if (session.scope) {
          const records = await this.options.records!(session.scope, session.since, session.until, packet.ids, peer, session.linkId)
          let batch: DeviceSyncRecord[] = []
          for (const record of records) {
            if (!requested.has(deviceSyncRecordId(record)) || deviceSyncRecordScope(record) !== session.scope) continue
            const candidate = { v: 1 as const, type: 'historyRecords' as const, session: session.id, records: [...batch, record], requested: [] }
            if (deviceSyncPacketByteLength(candidate) > DEVICE_SYNC_MAX_PACKET_BYTES) {
              if (batch.length) await this.send(peer, state, session, { ...candidate, records: batch })
              batch = []
            }
            if (deviceSyncPacketByteLength({ ...candidate, records: [record] }) <= DEVICE_SYNC_MAX_PACKET_BYTES) batch.push(record)
          }
          if (batch.length) await this.send(peer, state, session, { v: 1, type: 'historyRecords', session: session.id, records: batch, requested: [] })
          await this.send(peer, state, session, { v: 1, type: 'historyRecords', session: session.id, records: [], requested: packet.ids })
          return
        }
        // Re-read current data: removals, expiry and policy changes win over the snapshot.
        const messages = await this.options.messages(session.since, session.until, packet.ids.map(id => session.records.get(id)!), peer, session.linkId)
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
      } else if (packet.type === 'historyRecords' && session.initiator && session.scope) {
        const ids = packet.records.map(deviceSyncRecordId)
        if (packet.records.some((record, index) => deviceSyncRecordScope(record) !== session.scope || deviceSyncRecordTime(record) < session.since || deviceSyncRecordTime(record) > session.until ||
          !session.requested.has(ids[index]) || session.received.has(ids[index])) || new Set(ids).size !== ids.length ||
          new Set(packet.requested).size !== packet.requested.length || packet.requested.some(id => !session.requested.has(id))) throw new Error('unsolicited history record')
        const imported = await this.options.applyRecords!(peer, packet.records, session.scope, session.since, session.until, session.linkId, () => this.live(peer, state, session))
        if (!this.live(peer, state, session)) return
        ids.forEach(id => session.received.add(id))
        session.imported += imported
        if (packet.requested.some(id => !session.received.has(id))) session.withheld = true
        packet.requested.forEach(id => session.requested.delete(id))
        if (session.scope !== 'state' && packet.requested.length) this.options.progress?.(peer, session.since, session.imported)
        await this.requestNext(peer, state, session)
      } else if (packet.type === 'historyMessages' && session.initiator && !session.scope) {
        const ids = packet.messages.map(historyRecordId)
        if (packet.messages.some((message, index) => message.createdAt < session.since || message.createdAt > session.until ||
          !session.requested.has(ids[index]) || session.received.has(ids[index])) || new Set(ids).size !== ids.length ||
          new Set(packet.requested).size !== packet.requested.length || packet.requested.some(id => !session.requested.has(id))) throw new Error('unsolicited history message')
        const imported = await this.options.apply(packet.messages, session.since, () => this.live(peer, state, session), peer, session.until, session.linkId)
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
      state[slot(true, session.scope)] = undefined
      if (session.scope !== 'state') await this.options.complete?.(peer, session.since, session.until, session.withheld)
      if (session.restart && (session.since > 0 || session.scope === 'state')) {
        const { since, until, linkId } = session.restart
        void this.start(peer, since, until, linkId, session.scope).catch(() => undefined)
      }
    }
  }

  private async session(id: string, since: number, until: number, initiator: boolean, scope?: DeviceSyncScope): Promise<HistorySession> {
    const inventory = scope ? (await this.options.recordInventory!(scope, since, until, initiator)).map(record => ({ ...record, chatId: '' })) : await this.options.inventory(since, until, initiator)
    const records = new Map(inventory.filter(item => item.createdAt >= since && item.createdAt <= until)
      .map(item => [scope ? item.id : historyRecordId(item), { chatId: item.chatId, id: item.id, createdAt: item.createdAt }]))
    const sessions = [...this.peers.values()].flatMap(peer => [peer.incoming, peer.outgoing, peer.stateIncoming, peer.stateOutgoing]).filter(session => session && session.expires > this.now())
    const retained = sessions
      .reduce((total, session) => total + (session?.records.size ?? 0), 0)
    if (records.size + retained > 200_000 || sessions.length >= 64) throw new Error('reconciliation window exceeds record limit')
    return { id, since, until, initiator, scope, expires: this.now() + 120_000,
      engine: new Reconciliation([...records].map(([id, message]) => ({ id: hexToBytes(id), timestamp: BigInt(message.createdAt) })),
        { since: BigInt(since), until: BigInt(until) }),
      records, pending: [], requested: new Set(), received: new Set(), complete: false, imported: 0, total: 0, withheld: false }
  }
  private now(): number { return this.options.now?.() ?? Date.now() }
  private valid(peer: string, state: HistoryPeer): boolean { return this.peers.get(peer) === state && this.options.authorized(peer) }
  private live(peer: string, state: HistoryPeer, session: HistorySession): boolean {
    return this.valid(peer, state) && session.expires > this.now() &&
      (session.scope === 'state' || session.initiator || (session.since >= Math.max(state.floor, this.options.floor?.(peer) ?? 0) &&
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

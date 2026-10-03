import { Reconciliation } from 'nostr-pubsub-reconcile'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { deviceSyncPacketByteLength, DEVICE_SYNC_MAX_PACKET_BYTES, DEVICE_SYNC_RECORD_BATCH, type DeviceHistoryPacket, type DeviceSyncMessage } from './deviceSyncProtocol'
import { deviceSyncRecordId, deviceSyncRecordScope, deviceSyncRecordTime, type DeviceSyncRecord, type DeviceSyncScope } from './deviceSyncRecords'

export type HistoryRecord = Pick<DeviceSyncMessage, 'chatId' | 'id' | 'createdAt'>
export const historyRecordId = (message: Pick<HistoryRecord, 'chatId' | 'id'>): string =>
  bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([message.chatId, message.id]))))

type Window = { since: number; until: number; linkId?: string; scope: DeviceSyncScope }
interface PartitionRun { pending: string[]; imported: number; withheld: boolean; restart?: { since: number; until?: number; linkId?: string } }
export interface DeviceRecordReference { id: string; createdAt: number; locator?: { type: DeviceSyncRecord['type']; key: string[] } }
interface HistorySession extends Window {
  id: string
  prefix: string
  expires: number
  engine: Reconciliation
  records: Map<string, DeviceRecordReference>
  initiator: boolean
  pending: string[]
  requested: Set<string>
  received: Set<string>
  complete: boolean
  run?: PartitionRun
}
interface HistoryPeer {
  floor: number
  latest?: number
  incoming?: HistorySession
  outgoing?: HistorySession
  stateIncoming?: HistorySession
  stateOutgoing?: HistorySession
}
const slot = (initiator: boolean, scope: DeviceSyncScope): 'incoming' | 'outgoing' | 'stateIncoming' | 'stateOutgoing' =>
  scope === 'state' ? initiator ? 'stateOutgoing' : 'stateIncoming' : initiator ? 'outgoing' : 'incoming'
const HEX = '0123456789abcdef'

/** Authenticated typed records use one reconciliation engine. Large sets are
 * partitioned by hash prefix without changing their approval or time window. */
export class DeviceHistorySync {
  private peers = new Map<string, HistoryPeer>()
  private queues = new Map<string, Promise<void>>()
  constructor(private options: {
    authorized(peer: string): boolean
    floor?(peer: string): number
    allowsWindow?(peer: string, since: number, until: number, linkId?: string): boolean
    recordInventory(scope: DeviceSyncScope, since: number, until: number, initiator: boolean, prefix: string): Promise<DeviceRecordReference[]>
    records(scope: DeviceSyncScope, since: number, until: number, references: DeviceRecordReference[], peer: string, linkId?: string): Promise<DeviceSyncRecord[]>
    applyRecords(peer: string, records: DeviceSyncRecord[], scope: DeviceSyncScope, since: number, until: number, linkId: string | undefined, authorized: () => boolean): Promise<number>
    progress?(peer: string, since: number, imported: number, total?: number): void
    complete?(peer: string, since: number, until: number, withheld: boolean): Promise<void>
    unavailable?(peer: string, since: number): void
    send(peer: string, packet: DeviceHistoryPacket): Promise<void>
    now?: () => number
    /** A lower cap is useful for constrained hosts and bounded integration tests. */
    maxInventoryRecords?: number
  }) {}

  reset(peer?: string): void { if (peer) this.peers.delete(peer); else this.peers.clear() }
  negotiate(peer: string, floor: number): void {
    const state = this.peers.get(peer)
    if (state) state.floor = floor
    else if (this.peers.size < 32) this.peers.set(peer, { floor })
  }
  observe(peer: string, timestamps: Iterable<number>): void {
    const state = this.peers.get(peer)
    if (!state || !this.options.authorized(peer)) return
    for (const timestamp of timestamps) if (Number.isSafeInteger(timestamp) && timestamp >= 0 && timestamp <= Math.floor(this.now() / 1000) + 300) {
      state.latest = Math.max(state.latest ?? 0, timestamp)
    }
  }
  startState(peer: string): Promise<void> { return this.start(peer, 0, 0, undefined, 'state') }
  start(peer: string, since: number, end?: number, linkId?: string, scope: DeviceSyncScope = 'history'): Promise<void> {
    return this.queue(peer, async () => {
      const state = this.peers.get(peer)
      if (!state || !this.valid(peer, state)) return
      const outgoing = state[slot(true, scope)]
      if (outgoing && this.live(peer, state, outgoing)) {
        if (!outgoing.run!.restart?.linkId || linkId) outgoing.run!.restart = { since, until: end, linkId }
        return
      }
      const until = scope === 'state' ? 0 : end ?? Math.max(since, Math.floor(this.now() / 1000), state.latest ?? 0)
      if (scope === 'history') this.options.progress?.(peer, since, 0)
      await this.begin(peer, state, { scope, since, until, linkId }, { pending: [''], imported: 0, withheld: false })
    })
  }

  receive(peer: string, packet: DeviceHistoryPacket): Promise<void> {
    return this.queue(peer, async () => {
      const state = this.peers.get(peer)
      if (!state || !this.valid(peer, state)) return
      if (packet.type === 'historyOpen') {
        if (packet.scope === 'history' && (packet.since < Math.max(state.floor, this.options.floor?.(peer) ?? 0) || packet.until > Math.floor(this.now() / 1000) + 300 ||
          this.options.allowsWindow?.(peer, packet.since, packet.until, packet.linkId) === false)) return
        if (packet.scope === 'state' && (packet.since !== 0 || packet.until !== 0 || packet.linkId)) return
        if ([state.outgoing, state.stateOutgoing].some(session => session?.id === packet.session)) return
        const incoming = state[slot(false, packet.scope)]
        if (incoming && this.live(peer, state, incoming)) return
        let session: HistorySession
        try { session = await this.session(packet.session, packet, false, packet.prefix ?? '') }
        catch (error) {
          if (!this.overflow(error)) throw error
          if (this.valid(peer, state)) await this.options.send(peer, { v: 1, type: 'historyOverflow', session: packet.session })
          return
        }
        if (!this.valid(peer, state)) return
        state[slot(false, packet.scope)] = session
        await this.send(peer, state, session, { v: 1, type: 'historyFrame', session: session.id, frame: bytesToHex(await session.engine.respond(hexToBytes(packet.frame))) })
        return
      }
      const session = [state.incoming, state.outgoing, state.stateIncoming, state.stateOutgoing].find(session => session?.id === packet.session)
      if (!session || !this.live(peer, state, session)) return
      if (packet.type === 'historyOverflow') {
        if (!session.initiator || session.complete || session.requested.size || session.received.size) throw new Error('Unexpected record overflow')
        state[slot(true, session.scope)] = undefined
        if (this.partition(session.run!, session.prefix)) await this.begin(peer, state, session, session.run!)
        else this.options.unavailable?.(peer, session.since)
        return
      }
      if (packet.type === 'historyDone') {
        state[slot(session.initiator, session.scope)] = undefined
        if (session.initiator && session.scope === 'history') this.options.unavailable?.(peer, session.since)
        return
      }
      if (packet.type === 'historyFrame') {
        if (!session.initiator) await this.send(peer, state, session, { v: 1, type: 'historyFrame', session: session.id, frame: bytesToHex(await session.engine.respond(hexToBytes(packet.frame))) })
        else {
          const step = await session.engine.reconcile(hexToBytes(packet.frame))
          session.pending.push(...step.need.map(bytesToHex))
          if (session.pending.length > 100_000) throw new Error('history demand limit exceeded')
          session.complete = !step.next
          if (step.next) await this.send(peer, state, session, { v: 1, type: 'historyFrame', session: session.id, frame: bytesToHex(step.next) })
          await this.requestNext(peer, state, session)
        }
      } else if (packet.type === 'historyNeed' && !session.initiator) {
        const requested = new Set(packet.ids)
        if (requested.size !== packet.ids.length || packet.ids.some(id => !id.startsWith(session.prefix) || !session.records.has(id) || session.received.has(id))) throw new Error('history request is outside the inventory or repeated')
        packet.ids.forEach(id => session.received.add(id))
        const records = await this.options.records(session.scope, session.since, session.until, packet.ids.map(id => session.records.get(id)!), peer, session.linkId)
        let batch: DeviceSyncRecord[] = []
        for (const record of records) {
          if (!requested.has(deviceSyncRecordId(record)) || deviceSyncRecordScope(record) !== session.scope) continue
          const candidate = { v: 1 as const, type: 'historyRecords' as const, session: session.id, records: [...batch, record], requested: [] }
          if (batch.length >= DEVICE_SYNC_RECORD_BATCH || deviceSyncPacketByteLength(candidate) > DEVICE_SYNC_MAX_PACKET_BYTES) {
            if (batch.length) await this.send(peer, state, session, { ...candidate, records: batch })
            batch = []
          }
          if (deviceSyncPacketByteLength({ ...candidate, records: [record] }) <= DEVICE_SYNC_MAX_PACKET_BYTES) batch.push(record)
        }
        if (batch.length) await this.send(peer, state, session, { v: 1, type: 'historyRecords', session: session.id, records: batch, requested: [] })
        await this.send(peer, state, session, { v: 1, type: 'historyRecords', session: session.id, records: [], requested: packet.ids })
      } else if (packet.type === 'historyRecords' && session.initiator) {
        const ids = packet.records.map(deviceSyncRecordId)
        if (packet.records.some((record, index) => deviceSyncRecordScope(record) !== session.scope || deviceSyncRecordTime(record) < session.since || deviceSyncRecordTime(record) > session.until ||
          !ids[index].startsWith(session.prefix) || !session.requested.has(ids[index]) || session.received.has(ids[index])) || new Set(ids).size !== ids.length ||
          new Set(packet.requested).size !== packet.requested.length || packet.requested.some(id => !session.requested.has(id))) throw new Error('unsolicited history record')
        const imported = await this.options.applyRecords(peer, packet.records, session.scope, session.since, session.until, session.linkId, () => this.live(peer, state, session))
        if (!this.live(peer, state, session)) return
        ids.forEach(id => session.received.add(id))
        session.run!.imported += imported
        if (packet.requested.some(id => !session.received.has(id))) session.run!.withheld = true
        packet.requested.forEach(id => session.requested.delete(id))
        if (session.scope === 'history' && packet.requested.length) this.options.progress?.(peer, session.since, session.run!.imported)
        await this.requestNext(peer, state, session)
      }
    })
  }

  private async requestNext(peer: string, state: HistoryPeer, session: HistorySession): Promise<void> {
    if (!session.complete || session.requested.size) return
    if (session.pending.length) {
      const ids = session.pending.splice(0, DEVICE_SYNC_RECORD_BATCH)
      session.requested = new Set(ids)
      await this.send(peer, state, session, { v: 1, type: 'historyNeed', session: session.id, ids })
      return
    }
    await this.send(peer, state, session, { v: 1, type: 'historyDone', session: session.id })
    if (!this.live(peer, state, session)) return
    state[slot(true, session.scope)] = undefined
    const run = session.run!
    if (run.pending.length) await this.begin(peer, state, session, run)
    else {
      if (session.scope === 'history') await this.options.complete?.(peer, session.since, session.until, run.withheld)
      if (run.restart && (session.since > 0 || session.scope === 'state')) {
        const { since, until, linkId } = run.restart
        void this.start(peer, since, until, linkId, session.scope).catch(() => undefined)
      }
    }
  }
  private partition(run: PartitionRun, prefix: string): boolean {
    if (prefix.length >= 64 || run.pending.length + 16 > 960) return false
    run.pending.unshift(...[...HEX].map(nibble => prefix + nibble))
    return true
  }
  private async begin(peer: string, state: HistoryPeer, window: Window, run: PartitionRun): Promise<void> {
    while (run.pending.length && this.valid(peer, state)) {
      const prefix = run.pending.shift()!
      let session: HistorySession
      try { session = await this.session(bytesToHex(crypto.getRandomValues(new Uint8Array(16))), window, true, prefix) }
      catch (error) {
        if (!this.overflow(error)) throw error
        if (this.partition(run, prefix)) continue
        if (window.scope === 'history') this.options.unavailable?.(peer, window.since)
        return
      }
      if (!this.valid(peer, state)) return
      session.run = run
      state[slot(true, window.scope)] = session
      await this.send(peer, state, session, { v: 1, type: 'historyOpen', session: session.id, scope: session.scope,
        since: session.since, until: session.until, ...(session.linkId && { linkId: session.linkId }), ...(prefix && { prefix }), frame: bytesToHex(await session.engine.initiate()) })
      return
    }
  }
  private async session(id: string, window: Window, initiator: boolean, prefix: string): Promise<HistorySession> {
    const inventory = (await this.options.recordInventory(window.scope, window.since, window.until, initiator, prefix))
      .filter(record => record.createdAt >= window.since && record.createdAt <= window.until && record.id.startsWith(prefix))
    const records = new Map(inventory.map(record => [record.id, record]))
    if (records.size > Math.max(1, Math.min(this.options.maxInventoryRecords ?? 100_000, 100_000))) throw new Error('reconciliation window exceeds record limit')
    for (const peer of this.peers.values()) for (const key of ['incoming', 'outgoing', 'stateIncoming', 'stateOutgoing'] as const) {
      if (peer[key] && peer[key]!.expires <= this.now()) peer[key] = undefined
    }
    const sessions = [...this.peers.values()].flatMap(peer => [peer.incoming, peer.outgoing, peer.stateIncoming, peer.stateOutgoing]).filter(session => session && session.expires > this.now())
    if (records.size + sessions.reduce((sum, session) => sum + session!.records.size, 0) > 200_000 || sessions.length >= 64) throw new Error('reconciliation capacity exhausted')
    return { ...window, id, prefix, initiator, expires: this.now() + 120_000, records,
      engine: new Reconciliation([...records].map(([id, record]) => ({ id: hexToBytes(id), timestamp: BigInt(record.createdAt) })), { since: BigInt(window.since), until: BigInt(window.until) }),
      pending: [], requested: new Set(), received: new Set(), complete: false }
  }
  private overflow(error: unknown): boolean { return error instanceof Error && error.message.includes('record limit') }
  private now(): number { return this.options.now?.() ?? Date.now() }
  private valid(peer: string, state: HistoryPeer): boolean { return this.peers.get(peer) === state && this.options.authorized(peer) }
  private live(peer: string, state: HistoryPeer, session: HistorySession): boolean {
    return this.valid(peer, state) && session.expires > this.now() && (session.scope === 'state' || session.initiator ||
      session.since >= Math.max(state.floor, this.options.floor?.(peer) ?? 0) && this.options.allowsWindow?.(peer, session.since, session.until, session.linkId) !== false)
  }
  private async send(peer: string, state: HistoryPeer, session: HistorySession, packet: DeviceHistoryPacket): Promise<void> {
    if (this.live(peer, state, session)) await this.options.send(peer, packet)
  }
  private queue(peer: string, operation: () => Promise<void>): Promise<void> {
    const queued = (this.queues.get(peer) ?? Promise.resolve()).catch(() => undefined).then(operation).catch(error => { this.reset(peer); throw error })
    this.queues.set(peer, queued)
    void queued.finally(() => { if (this.queues.get(peer) === queued) this.queues.delete(peer) }).catch(() => undefined)
    return queued
  }
}

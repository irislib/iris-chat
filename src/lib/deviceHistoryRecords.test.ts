import { describe, expect, it, vi } from 'vitest'
import { DeviceHistorySync } from './deviceHistorySync'
import { deviceSyncRecordId, deviceSyncRecordScope, deviceSyncRecordTime, type DeviceSyncRecord } from './deviceSyncRecords'
import type { DeviceHistoryPacket } from './deviceSyncProtocol'
import fixtures from './fixtures/deviceSyncRecords.json'

function pair(source: DeviceSyncRecord[]) {
  const contents = [new Map<string, DeviceSyncRecord>(), new Map(source.map(record => [deviceSyncRecordId(record), record]))]
  const packets: Array<{ receiver: number; packet: DeviceHistoryPacket }> = []
  const progress: number[] = [], complete: number[] = []
  const engines = contents.map((records, index) => new DeviceHistorySync({
    authorized: () => true, now: () => 200_000,
    inventory: async () => [], messages: async () => [], apply: async () => 0,
    recordInventory: async (scope, since, until) => [...records.values()].filter(record => deviceSyncRecordScope(record) === scope && deviceSyncRecordTime(record) >= since && deviceSyncRecordTime(record) <= until)
      .map(record => ({ id: deviceSyncRecordId(record), createdAt: deviceSyncRecordTime(record) })),
    records: async (_scope, _since, _until, ids) => ids.flatMap(id => records.has(id) ? [records.get(id)!] : []),
    applyRecords: async (_peer, received) => { for (const record of received) records.set(deviceSyncRecordId(record), record); return received.filter(record => record.type === 'message').length },
    progress: () => progress.push(index), complete: async () => { complete.push(index) },
    send: async (_peer, packet) => { packets.push({ receiver: 1 - index, packet }) },
  }))
  engines[0].negotiate('b', 100, true); engines[1].negotiate('a', 100, true)
  return { engines, contents, progress, complete, packets, drain: async () => {
    for (let count = 0; packets.length; count++) {
      if (count > 100) throw new Error('record transfer did not finish')
      const { receiver, packet } = packets.shift()!
      await engines[receiver].receive(receiver === 0 ? 'b' : 'a', packet)
    }
  } }
}

describe('typed reconciliation scopes', () => {
  it('syncs current state with history opt-out and keeps old reactions excluded', async () => {
    const base = (fixtures.find(item => item.name === 'reaction-remove')!.record as Extract<DeviceSyncRecord, { type: 'reaction' }>).reaction
    const source: DeviceSyncRecord[] = [
      { type: 'reaction', reaction: { ...base, createdAt: 99, createdAtMs: undefined } },
      { type: 'reaction', reaction: { ...base, id: 'b'.repeat(64), createdAt: 110, createdAtMs: undefined } },
      fixtures.find(item => item.name === 'group')!.record as DeviceSyncRecord,
    ]
    const p = pair(source)
    await p.engines[0].start('b', 100)
    await p.engines[0].startState('b')
    await p.drain()
    expect([...p.contents[0].values()].map(record => record.type).sort()).toEqual(['group', 'reaction'])
    expect(p.contents[0].has(deviceSyncRecordId(source[0]))).toBe(false)
    expect(p.complete).toEqual([0])
    const progress = [...p.progress]
    await p.engines[0].startState('b'); await p.drain()
    expect(p.progress).toEqual(progress)
    expect(p.complete).toEqual([0])
  })
  it('refuses repeated completion IDs before applying any records', async () => {
    const group = fixtures.find(item => item.name === 'group')!.record as DeviceSyncRecord
    const p = pair([group])
    await p.engines[0].startState('b')
    while (p.packets[0]?.packet.type !== 'historyRecords') {
      const next = p.packets.shift()!
      await p.engines[next.receiver].receive(next.receiver === 0 ? 'b' : 'a', next.packet)
    }
    const packet = p.packets.shift()!.packet
    if (packet.type !== 'historyRecords') throw new Error('Expected records')
    const id = deviceSyncRecordId(group)
    await expect(p.engines[0].receive('b', { ...packet, requested: [id, id] })).rejects.toThrow('unsolicited')
    expect(p.contents[0].size).toBe(0)
  })
  it('does not acknowledge oversized typed history via message-only fallback', async () => {
    const fallback = vi.fn(), unavailable = vi.fn(), complete = vi.fn()
    const engine = new DeviceHistorySync({ authorized: () => true, inventory: async () => [], messages: async () => [], apply: async () => 0,
      recordInventory: async () => { throw new Error('reconciliation window exceeds record limit') },
      records: async () => [], applyRecords: async () => 0, fallback, unavailable, complete, send: async () => {} })
    engine.negotiate('peer', 0, true)
    await engine.start('peer', 0, 100)
    expect(unavailable).toHaveBeenCalledWith('peer', 0)
    expect(fallback).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled()
  })
  it('refuses history records smuggled into the state scope', async () => {
    const group = fixtures.find(item => item.name === 'group')!.record as DeviceSyncRecord
    const p = pair([group])
    await p.engines[0].startState('b')
    const open = p.packets.shift()!.packet
    await expect(p.engines[0].receive('b', { v: 1, type: 'historyRecords', session: open.session,
      records: [fixtures[0].record as DeviceSyncRecord], requested: [] })).rejects.toThrow('unsolicited')
  })
})

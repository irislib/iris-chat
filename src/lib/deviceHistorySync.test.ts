// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DeviceHistorySync, historyRecordId } from './deviceHistorySync'
import { encodeDeviceSyncPacket, parseDeviceSyncPacket, type DeviceHistoryPacket, type DeviceSyncMessage } from './deviceSyncProtocol'

const owner = 'a'.repeat(64)
const contact = 'b'.repeat(64)
const message = (id: string, createdAt = 100): DeviceSyncMessage => ({ chatId: contact, id, createdAt, author: owner, body: `Message ${id} ☕` })
function pair(initialA: DeviceSyncMessage[], initialB: DeviceSyncMessage[], since = 0) {
  const a = new Map(initialA.map(message => [historyRecordId(message), message]))
  const b = new Map(initialB.map(message => [historyRecordId(message), message]))
  const tombstones = new Map<string, DeviceSyncMessage>()
  const queue: Array<{ to: 'a' | 'b'; packet: DeviceHistoryPacket }> = []
  const sent: DeviceHistoryPacket[] = []
  let authorized = true
  let now = 200_000
  const options = (local: Map<string, DeviceSyncMessage>, to: 'a' | 'b') => ({
    authorized: () => authorized, now: () => now, floor: () => since,
    inventory: async (_since: number, _until: number, initiator: boolean) => [...local.values(), ...(initiator && to === 'b' ? tombstones.values() : [])],
    messages: async (since: number, until: number) => [...local.values()].filter(message => message.createdAt >= since && message.createdAt <= until),
    apply: async (messages: DeviceSyncMessage[]) => {
      for (const message of messages) if (!tombstones.has(historyRecordId(message))) local.set(historyRecordId(message), message)
    },
    send: async (_: string, packet: DeviceHistoryPacket) => {
      const decoded = parseDeviceSyncPacket(encodeDeviceSyncPacket(packet), owner) as DeviceHistoryPacket
      sent.push(decoded)
      queue.push({ to, packet: decoded })
    },
  })
  const first = new DeviceHistorySync(options(a, 'b'))
  const second = new DeviceHistorySync(options(b, 'a'))
  first.negotiate('b', since)
  second.negotiate('a', since)
  const drain = async () => {
    let count = 0
    while (queue.length) {
      if (++count > 2000) throw new Error('history did not converge')
      const { to, packet } = queue.shift()!
      await (to === 'a' ? first : second).receive(to === 'a' ? 'b' : 'a', packet)
    }
  }
  return { a, b, first, second, queue, sent, tombstones, drain,
    revoke: () => { authorized = false }, advance: () => { now += 121_000 } }
}

describe('encrypted device history reconciliation', () => {
  it('fetches only missing messages in both directions and repairs an offline gap after reconnect', async () => {
    const shared = Array.from({ length: 120 }, (_, i) => message(`shared-${i}`))
    const p = pair([...shared, message('only-a')], [...shared, message('only-b')])
    await p.first.start('b', 0)
    await p.second.start('a', 0)
    await p.drain()
    expect([...p.a.keys()].sort()).toEqual([...p.b.keys()].sort())
    expect(p.sent.filter(packet => packet.type === 'historyMessages').flatMap(packet => packet.messages).map(message => message.id).sort()).toEqual(['only-a', 'only-b'])
    p.first.reset('b'); p.second.reset('a')
    p.b.set(historyRecordId(message('offline', 150)), message('offline', 150))
    p.first.negotiate('b', 0); p.second.negotiate('a', 0)
    p.sent.length = 0
    await p.first.start('b', 0); await p.drain()
    expect(p.a.size).toBe(123)
    expect(p.sent.filter(packet => packet.type === 'historyMessages').flatMap(packet => packet.messages).map(message => message.id)).toEqual(['offline'])
  })

  it('keeps list-only pre-link history excluded while repairing newer messages', async () => {
    const p = pair([], [message('old', 90), message('new', 110)], 100)
    await p.first.start('b', 100); await p.drain()
    expect([...p.a.values()].map(message => message.id)).toEqual(['new'])
    p.first.reset('b'); p.second.reset('a')
    p.first.negotiate('b', 100); p.second.negotiate('a', 100)
    await p.first.start('b', 0); await p.drain()
    expect([...p.a.values()].map(message => message.id)).toEqual(['new'])
  })

  it('does not request deleted IDs or revive them on later reconciliation', async () => {
    const removed = message('removed')
    const p = pair([], [removed, message('kept')])
    p.tombstones.set(historyRecordId(removed), removed)
    await p.first.start('b', 0); await p.drain()
    expect([...p.a.values()].map(message => message.id)).toEqual(['kept'])
    expect(p.sent.filter(packet => packet.type === 'historyNeed').flatMap(packet => packet.ids)).not.toContain(historyRecordId(removed))
  })

  it('does not advertise local tombstones when responding to the other device', async () => {
    const p = pair([], [])
    const removed = message('removed')
    p.tombstones.set(historyRecordId(removed), removed)
    await p.second.start('a', 0); await p.drain()
    expect(p.sent.some(packet => packet.type === 'historyNeed')).toBe(false)
    expect(p.sent.at(-1)?.type).toBe('historyDone')
  })

  it('withholds a message deleted after inventory without stalling other requests', async () => {
    const p = pair([], Array.from({ length: 40 }, (_, i) => message(`id-${i}`)))
    await p.first.start('b', 0)
    const open = p.queue.shift()!
    await p.second.receive('a', open.packet)
    p.b.clear()
    await p.drain()
    expect(p.a.size).toBe(0)
    expect(p.sent.at(-1)?.type).toBe('historyDone')
  })

  it('drops revoked and expired sessions before transfer', async () => {
    for (const action of ['revoke', 'advance'] as const) {
      const p = pair([], [message('secret')])
      await p.first.start('b', 0)
      const open = p.queue.shift()!
      await p.second.receive('a', open.packet)
      p[action]()
      await p.drain()
      expect(p.a.size).toBe(0)
      expect(p.sent.some(packet => packet.type === 'historyMessages')).toBe(false)
    }
  })

  it('rejects unrequested content and clears the poisoned session', async () => {
    const p = pair([], [message('expected')])
    await p.first.start('b', 0)
    const open = p.queue[0].packet
    await expect(p.first.receive('b', { v: 1, type: 'historyMessages', session: open.session, messages: [message('injected')], requested: [] })).rejects.toThrow('unsolicited')
    await p.drain()
    expect(p.a.size).toBe(0)
  })
})

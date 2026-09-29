import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { callHistoryFromState, callHistoryLabel } from './callHistory'
import { CallSession, type CallEndpoint } from './callSession'
import { CallMediaReceiver, encodeCallControl, encodeCallMedia, parseCallControl } from './callProtocol'
class Endpoint implements CallEndpoint {
  handler?: (ctx: { src: string; payload: Uint8Array }) => void
  other?: Endpoint
  others?: Map<string, Endpoint>
  sent: Uint8Array[] = []
  drop = false
  dropEndTo?: string
  gate?: Promise<void>
  constructor(readonly id: string) {}
  registerService(_port: number, handler: typeof this.handler) { this.handler = handler; return () => { this.handler = undefined } }
  async sendDatagram({ dst, payload }: { dst: string; srcPort: number; dstPort: number; payload: Uint8Array }) {
    this.sent.push(payload)
    if (!this.drop && !(dst === this.dropEndTo && parseCallControl(payload)?.type === 'end')) (this.others?.get(dst) ?? this.other)?.handler?.({ src: this.id, payload })
    await this.gate
  }
}
const id = 'ab'.repeat(16)
function packet(size: number) { return new Uint8Array(size).fill(17) }
describe('FIPS calls', () => {
  let a: CallSession, b: CallSession, ea: Endpoint, eb: Endpoint
  beforeEach(() => {
    vi.useFakeTimers()
    ea = new Endpoint('a'); eb = new Endpoint('b'); ea.other = eb; eb.other = ea
    a = new CallSession(ea, peer => peer === 'b' ? 'Bob' : undefined)
    b = new CallSession(eb, peer => peer === 'a' ? 'Alice' : undefined)
  })
  afterEach(() => { a.dispose(); b.dispose(); vi.useRealTimers() })
  it('rechecks caller authorization before answering without waiting for a timer', () => {
    b.dispose()
    let allowed = true
    b = new CallSession(eb, peer => allowed && peer === 'a' ? 'Alice' : undefined)
    a.start('Bob', ['b'], false)
    expect(get(b.state)?.status).toBe('ringing')
    allowed = false
    b.accept(false)
    expect(get(b.state)?.status).toBe('ended')
    expect(eb.sent.some(packet => parseCallControl(packet)?.type === 'answer')).toBe(false)
  })
  it('matches authenticated device addresses across compressed key parity after an upgrade', async () => {
    a.dispose()
    const x = 'a1'.repeat(32), advertised = `02${x}`, authenticated = `03${x}`
    a = new CallSession(ea, peer => [advertised, authenticated].includes(peer) ? 'Bob' : undefined)
    a.start('Bob', [advertised, authenticated], true)
    expect(get(a.state)?.peers).toHaveLength(1)
    const callId = get(a.state)!.id
    ea.handler?.({ src: authenticated, payload: encodeCallControl({ v: 3, type: 'answer', call_id: callId, video: true }) })
    expect(get(a.state)?.status).toBe('active')
    const delivered = vi.fn(); a.onMedia = delivered
    for (const payload of encodeCallMedia(callId, { kind: 1, key: false, seq: 0, timestamp: 0, bytes: packet(20) })) {
      ea.handler?.({ src: advertised, payload })
    }
    expect(delivered).toHaveBeenCalledOnce()
    ea.handler?.({ src: advertised, payload: encodeCallControl({ v: 3, type: 'end', call_id: callId }) })
    expect(get(a.state)?.status).toBe('ended')
  })
  it.each([false, true])('records answered elsewhere on a sibling (locally accepted: %s)', (siblingAccepted: boolean) => {
    a.dispose()
    const ec = new Endpoint('c'); ec.other = ea
    const c = new CallSession(ec, source => source === 'a' ? 'Alice' : undefined)
    ea.others = new Map([['b', eb], ['c', ec]])
    a = new CallSession(ea, source => ['b', 'c'].includes(source) ? 'Bob' : undefined)
    try {
      a.start('Bob', ['b', 'c'], true)
      const callId = get(a.state)!.id
      if (siblingAccepted) {
        ec.drop = true
        c.markMediaReady(); c.accept(true)
        expect(get(c.state)?.connected).toBeDefined()
        vi.advanceTimersByTime(1200)
      }
      a.markMediaReady(); b.markMediaReady(); b.accept(false)
      expect(get(a.state)).toMatchObject({ status: 'active', peer: 'b', video: false })
      expect(get(b.state)?.status).toBe('active')
      expect(get(c.state)).toMatchObject({ status: 'ended', outcome: 'answered_elsewhere', video: false })
      const history = callHistoryFromState(get(c.state)!)
      expect(history.outcome).toBe('answered_elsewhere')
      expect(history.answeredAt).toBeUndefined()
      expect(history.durationSeconds).toBe(0)
      expect(callHistoryLabel(history)).toBe('Answered on another device')
      ea.handler?.({ src: 'c', payload: encodeCallControl({ v: 3, type: 'answer', call_id: callId, video: true }) })
      expect(get(a.state)?.peer).toBe('b')
    } finally { c.dispose() }
  })
  it.each(['answer', 'ping'])('repeats a lost answered-elsewhere notice on sibling %s', (type: 'answer' | 'ping') => {
    a.dispose()
    const ec = new Endpoint('c'); ec.other = ea
    const c = new CallSession(ec, source => source === 'a' ? 'Alice' : undefined)
    ea.others = new Map([['b', eb], ['c', ec]])
    a = new CallSession(ea, source => ['b', 'c'].includes(source) ? 'Bob' : undefined)
    try {
      a.start('Bob', ['b', 'c'], true)
      const callId = get(a.state)!.id
      ec.drop = true; c.markMediaReady(); c.accept(true)
      ea.dropEndTo = 'c'; b.markMediaReady(); b.accept(false)
      expect(get(c.state)?.status).toBe('active')
      const sent = ea.sent.length
      ea.dropEndTo = undefined
      ea.handler?.({ src: 'c', payload: encodeCallControl({ v: 3, type, call_id: 'ee'.repeat(16), video: true }) })
      expect(ea.sent).toHaveLength(sent)
      ea.handler?.({ src: 'c', payload: encodeCallControl({ v: 3, type, call_id: callId, video: true }) })
      expect(get(a.state)).toMatchObject({ status: 'active', peer: 'b', video: false })
      expect(get(c.state)).toMatchObject({ status: 'ended', outcome: 'answered_elsewhere', video: false })
      expect(callHistoryFromState(get(c.state)!).durationSeconds).toBe(0)
    } finally { c.dispose() }
  })
  it.each(['answer', 'decline', 'cancel'])('recovers a lost %s notice on a still-ringing sibling', (action: string) => {
    a.dispose()
    const ec = new Endpoint('c'); ec.other = ea
    const c = new CallSession(ec, source => source === 'a' ? 'Alice' : undefined)
    ea.others = new Map([['b', eb], ['c', ec]])
    a = new CallSession(ea, source => ['b', 'c'].includes(source) ? 'Bob' : undefined)
    try {
      a.start('Bob', ['b', 'c'], true)
      ea.dropEndTo = 'c'
      if (action === 'answer') b.accept(false)
      else if (action === 'decline') b.end('Call declined', true, 'declined')
      else a.end()
      expect(get(c.state)?.status).toBe('ringing')
      // Recovery must also work when the accepted call has already finished.
      if (action === 'answer') a.end()
      ea.dropEndTo = undefined
      vi.advanceTimersByTime(3000)
      expect(get(c.state)).toMatchObject({ status: 'ended', outcome: action === 'answer' ? 'answered_elsewhere' : action === 'decline' ? 'declined' : 'missed' })
    } finally { c.dispose() }
  })
  it('retries a lost explicit decline and declines all ringing devices', () => {
    a.start('Bob', ['b'], false)
    eb.drop = true; b.end('Call declined', true, 'declined'); eb.drop = false
    expect(get(a.state)?.status).toBe('ringing')
    vi.advanceTimersByTime(1000)
    expect(get(a.state)).toMatchObject({ status: 'ended', outcome: 'declined' })
  })
  it('stops ringing within eleven seconds if the caller disappears', () => {
    a.start('Bob', ['b'], false)
    ea.drop = true
    vi.advanceTimersByTime(11000)
    expect(get(b.state)).toMatchObject({ status: 'ended', reason: 'Connection lost' })
  })
  it('counts answered duration only after accepted media is ready', () => {
    a.start('Bob', ['b'], true)
    b.accept(false)
    expect(get(a.state)?.connected).toBeUndefined()
    expect(get(b.state)?.connected).toBeUndefined()
    vi.advanceTimersByTime(1200)
    a.markMediaReady(); b.markMediaReady()
    const began = get(a.state)!.connected!
    vi.advanceTimersByTime(3200)
    a.end()
    expect(get(a.state)).toMatchObject({ outcome: 'answered', endedAt: began + 3200, video: false })
    expect(get(b.state)?.outcome).toBe('answered')
  })
  it('records missed incoming and canceled outgoing calls, with replay ignored', () => {
    a.start('Bob', ['b'], false)
    const offer = ea.sent[0]
    a.end()
    expect(get(a.state)?.outcome).toBe('canceled')
    expect(get(b.state)?.outcome).toBe('missed')
    b.clear()
    eb.handler?.({ src: 'a', payload: offer })
    expect(get(b.state)).toBeNull()
  })
  it('distinguishes explicit declines and an accepted call whose media never opens', () => {
    a.start('Bob', ['b'], false)
    b.end('Call ended', true, 'declined')
    expect(get(a.state)?.outcome).toBe('declined')
    expect(get(b.state)?.outcome).toBe('declined')
    a.start('Bob', ['b'], true); b.accept(true); a.end()
    expect(get(a.state)?.outcome).toBe('canceled')
    expect(get(b.state)?.outcome).toBe('missed')
  })
  it('sends no media before answer, then carries compressed Opus and H264 frames', async () => {
    const frames = vi.fn(); b.onMedia = frames
    a.start('Bob', ['b'], true)
    await a.sendMedia({ kind: 1, seq: 0, timestamp: 0, key: true, bytes: new Uint8Array(640) })
    expect(frames).not.toHaveBeenCalled()
    b.accept(true)
    expect(get(a.state)?.status).toBe('active')
    await a.sendMedia({ kind: 1, seq: 0, timestamp: 0, key: true, bytes: new Uint8Array(640) })
    const frame = packet(5000)
    await a.sendMedia({ kind: 2, seq: 0, timestamp: 0, key: true, bytes: frame })
    expect(frames).toHaveBeenCalledTimes(2)
    expect(frames.mock.calls[1][0].bytes).toEqual(frame)
    a.end()
    expect(get(b.state)?.status).toBe('ended')
    await a.sendMedia({ kind: 1, seq: 0, timestamp: 0, key: true, bytes: new Uint8Array(640) })
    expect(frames).toHaveBeenCalledTimes(2)
  })
  it('supports answering a video offer with voice and keeps control packets flowing', async () => {
    a.start('Bob', ['b'], true); b.accept(false)
    expect(get(a.state)?.video).toBe(false)
    expect(get(a.state)?.camera).toBe(false)
    expect(get(b.state)?.video).toBe(false)
    const receive = vi.fn(); b.onMedia = receive
    await a.sendMedia({ kind: 1, seq: 0, timestamp: 0, key: true, bytes: new Uint8Array(100) })
    expect(receive).toHaveBeenCalledTimes(1)
  })
  it('ignores strangers, rejects disabled calls, admits video as voice when only voice enabled', () => {
    eb.handler?.({ src: 'stranger', payload: encodeCallControl({ v: 3, type: 'offer', call_id: id }) })
    expect(get(b.state)).toBeNull()
    b.dispose()
    b = new CallSession(eb, () => 'Alice', () => ({ voice: false, video: false }))
    a.start('Bob', ['b'], true)
    expect(get(a.state)?.reason).toBe('Call declined')
    expect(get(b.state)).toBeNull()
    b.dispose()
    b = new CallSession(eb, () => 'Alice', () => ({ voice: true, video: false }))
    a.start('Bob', ['b'], true); b.accept(false)
    expect(get(a.state)?.video).toBe(false)
  })
  it('retries dropped control packets and ends a disconnected call within 15 seconds', () => {
    ea.drop = true; a.start('Bob', ['b'], false)
    expect(get(b.state)).toBeNull()
    ea.drop = false; vi.advanceTimersByTime(1000)
    expect(get(b.state)?.status).toBe('ringing')
    eb.drop = true; b.accept(false)
    expect(get(a.state)?.status).toBe('ringing')
    eb.drop = false; vi.advanceTimersByTime(1000)
    expect(get(a.state)?.status).toBe('active')
    ea.drop = true; eb.drop = true; vi.advanceTimersByTime(16000)
    expect(get(a.state)?.reason).toBe('Connection lost')
    expect(get(b.state)?.reason).toBe('Connection lost')
  })
  it('times out unanswered offers and prevents an ended offer replay from ringing again', () => {
    a.start('Bob', ['b'], false)
    const offer = ea.sent[0]
    vi.advanceTimersByTime(31000)
    expect(get(a.state)?.status).toBe('ended')
    b.clear()
    eb.handler?.({ src: 'a', payload: offer })
    expect(get(b.state)).toBeNull()
  })
  it('heartbeats carry camera/mute state and duplicate offers retain negotiated video', () => {
    a.start('Bob', ['b'], true); const offer = ea.sent[0]; b.accept(true)
    b.setMedia(true, false)
    eb.handler?.({ src: 'a', payload: offer })
    const answer = eb.sent.map(parseCallControl).filter(p => p?.type === 'answer').at(-1)
    expect(answer?.video).toBe(true)
    vi.advanceTimersByTime(4000)
    const heartbeat = eb.sent.map(parseCallControl).find(p => p?.type === 'ping' || p?.type === 'pong')
    expect(heartbeat?.video).toBe(false)
    expect(heartbeat?.muted).toBe(true)
    expect(get(a.state)?.remoteMuted).toBe(true)
    expect(get(a.state)?.remoteVideo).toBe(false)
  })
  it('remembers cancellation received before a delayed offer', () => {
    eb.handler?.({ src: 'a', payload: encodeCallControl({ v: 3, type: 'end', call_id: id }) })
    eb.handler?.({ src: 'a', payload: encodeCallControl({ v: 3, type: 'offer', call_id: id }) })
    expect(get(b.state)).toBeNull()
  })
  it('does not resume an old fragmented frame after a new call starts', async () => {
    a.start('Bob', ['b'], true); b.accept(true)
    let release!: () => void
    ea.gate = new Promise<void>(resolve => { release = resolve })
    const pending = a.sendMedia({ kind: 2, seq: 0, timestamp: 0, key: true, bytes: packet(5000) })
    const oldId = get(a.state)!.id
    a.end(); a.start('Bob', ['b'], true); b.accept(true)
    expect(get(a.state)?.id).not.toBe(oldId)
    release(); await pending
    expect(ea.sent.filter(bytes => bytes[0] === 73)).toHaveLength(1)
  })
  it('stops pending video fragments when the camera is turned off', async () => {
    a.start('Bob', ['b'], true); b.accept(true)
    let release!: () => void
    ea.gate = new Promise<void>(resolve => { release = resolve })
    const pending = a.sendMedia({ kind: 2, seq: 1, timestamp: 0, key: true, bytes: packet(5000) })
    a.setMedia(false, false)
    release(); await pending
    expect(ea.sent.filter(bytes => bytes[0] === 73)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(150)
    expect(ea.sent.filter(bytes => bytes[0] === 73)).toHaveLength(1)
  })
  it('revokes source fragments and retransmits even when outgoing video stays enabled', async () => {
    a.start('Bob', ['b'], true); b.accept(true)
    let release!: () => void, sourceIsCurrent = true
    ea.gate = new Promise<void>(resolve => { release = resolve })
    const pending = a.sendMedia({ kind: 2, seq: 1, timestamp: 0, key: true, bytes: packet(5000) }, () => sourceIsCurrent)
    sourceIsCurrent = false // Stop sharing and restore an enabled camera.
    release(); await pending
    expect(get(a.state)?.camera).toBe(true)
    expect(ea.sent.filter(bytes => bytes[0] === 73)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(150)
    expect(eb.sent.map(parseCallControl).some(p => p?.type === 'nack')).toBe(true)
    expect(ea.sent.filter(bytes => bytes[0] === 73)).toHaveLength(1)
  })
  it('keeps rejected offers rejected after preferences are enabled', () => {
    b.dispose()
    let enabled = false
    b = new CallSession(eb, () => 'Alice', () => ({ voice: enabled, video: enabled }))
    const packet = encodeCallControl({ v: 3, type: 'offer', call_id: id })
    eb.handler?.({ src: 'a', payload: packet })
    enabled = true
    eb.handler?.({ src: 'a', payload: packet })
    expect(get(b.state)).toBeNull()
  })
  it('resolves simultaneous outgoing calls in favor of the lower call id', () => {
    ea.drop = true; eb.drop = true
    a.start('Bob', ['b'], true); b.start('Alice', ['a'], true)
    const aOffer = ea.sent[0], bOffer = eb.sent[0]
    ea.drop = false; eb.drop = false
    // Deliver both offers before a busy rejection can influence delivery order.
    const aId = get(a.state)!.id, bId = get(b.state)!.id
    if (aId < bId) eb.handler?.({ src: 'a', payload: aOffer })
    else ea.handler?.({ src: 'b', payload: bOffer })
    const incoming = get(a.state)?.direction === 'incoming' ? a : b
    incoming.accept(true)
    expect(get(a.state)?.id).toBe(get(b.state)?.id)
    expect(get(a.state)?.status).toBe('active')
    expect(get(b.state)?.status).toBe('active')
  })
  it('recovers missing video fragments with bounded NACK retransmission', async () => {
    a.start('Bob', ['b'], true); b.accept(true)
    const handler = eb.handler!, receive = vi.fn(); b.onMedia = receive
    let lost = false
    eb.handler = context => {
      if (!lost && context.payload[20] === 2 && new DataView(context.payload.buffer).getUint16(34) === 1) { lost = true; return }
      handler(context)
    }
    await a.sendMedia({ kind: 2, seq: 1, timestamp: 20000, key: true, bytes: packet(5000) })
    expect(receive).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60)
    expect(receive).toHaveBeenCalledTimes(1)
    expect(receive.mock.calls[0][0].bytes).toHaveLength(5000)
    expect(eb.sent.map(parseCallControl).some(p => p?.type === 'nack')).toBe(true)
  })
  it('retains reordered compressed frames while suppressing duplicate packets', () => {
    const receiver = new CallMediaReceiver()
    const newer = encodeCallMedia(id, { kind: 2, seq: 10, timestamp: 0, key: true, bytes: packet(10) })[0]
    const older = encodeCallMedia(id, { kind: 2, seq: 9, timestamp: 0, key: true, bytes: packet(10) })[0]
    expect(receiver.receive(id, newer, 0)?.seq).toBe(10)
    expect(receiver.receive(id, older, 1)?.seq).toBe(9)
    expect(receiver.receive(id, newer, 2)).toBeNull()
  })
  it('validates controls and bounds fragmented media by size, age, identity and sequence', () => {
    expect(parseCallControl(new TextEncoder().encode(JSON.stringify({ v: 3, type: 'offer', call_id: id, video: 'yes' })))).toBeNull()
    const receiver = new CallMediaReceiver()
    const parts = encodeCallMedia(id, { kind: 2, seq: 1, timestamp: 0, key: true, bytes: packet(2500) })
    expect(receiver.receive(id, parts[0], 0)).toBeNull()
    expect(receiver.receive(id, parts[1], 600)).toBeNull()
    expect(receiver.receive(id, parts[2], 600)).toBeNull()
    const fresh = encodeCallMedia(id, { kind: 2, seq: 2, timestamp: 0, key: true, bytes: packet(2000) })
    expect(receiver.receive(id, fresh[1], 610)).toBeNull()
    expect(receiver.receive(id, fresh[0], 610)?.bytes.length).toBe(2000)
    expect(receiver.receive(id, fresh[0], 620)).toBeNull()
    expect(receiver.receive('ff'.repeat(16), fresh[0], 620)).toBeNull()
    expect(encodeCallMedia(id, { kind: 2, seq: 3, timestamp: 0, key: true, bytes: new Uint8Array(262145) })).toHaveLength(0)
  })
})

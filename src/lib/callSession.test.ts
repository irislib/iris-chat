import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { CallSession, type CallEndpoint } from './callSession'
import { CallMediaReceiver, encodeCallControl, encodeCallMedia, parseCallControl } from './callProtocol'
class Endpoint implements CallEndpoint {
  handler?: (ctx: { src: string; payload: Uint8Array }) => void
  other?: Endpoint
  sent: Uint8Array[] = []
  drop = false
  gate?: Promise<void>
  constructor(readonly id: string) {}
  registerService(_port: number, handler: typeof this.handler) { this.handler = handler; return () => { this.handler = undefined } }
  async sendDatagram({ payload }: { dst: string; srcPort: number; dstPort: number; payload: Uint8Array }) {
    this.sent.push(payload)
    if (!this.drop) this.other?.handler?.({ src: this.id, payload })
    await this.gate
  }
}
const id = 'ab'.repeat(16)
function jpeg(size: number) { const bytes = new Uint8Array(size); bytes.set([255, 216]); bytes.set([255, 217], size - 2); return bytes }
describe('FIPS calls', () => {
  let a: CallSession, b: CallSession, ea: Endpoint, eb: Endpoint
  beforeEach(() => {
    vi.useFakeTimers()
    ea = new Endpoint('a'); eb = new Endpoint('b'); ea.other = eb; eb.other = ea
    a = new CallSession(ea, peer => peer === 'b' ? 'Bob' : undefined)
    b = new CallSession(eb, peer => peer === 'a' ? 'Alice' : undefined)
  })
  afterEach(() => { a.dispose(); b.dispose(); vi.useRealTimers() })
  it('sends no media before answer, then carries audio and fragmented video in both directions', async () => {
    const frames = vi.fn(); b.onMedia = frames
    a.start('Bob', ['b'], true)
    await a.sendMedia(1, new Uint8Array(640))
    expect(frames).not.toHaveBeenCalled()
    b.accept(true)
    expect(get(a.state)?.status).toBe('active')
    await a.sendMedia(1, new Uint8Array(640))
    const frame = jpeg(5000)
    await a.sendMedia(2, frame)
    expect(frames).toHaveBeenCalledTimes(2)
    expect(frames.mock.calls[1][0].bytes).toEqual(frame)
    a.end()
    expect(get(b.state)?.status).toBe('ended')
    await a.sendMedia(1, new Uint8Array(640))
    expect(frames).toHaveBeenCalledTimes(2)
  })
  it('supports answering a video offer with voice and forbids subsequent video', async () => {
    a.start('Bob', ['b'], true); b.accept(false)
    expect(get(a.state)?.video).toBe(false)
    expect(get(a.state)?.camera).toBe(false)
    expect(get(b.state)?.video).toBe(false)
    const receive = vi.fn(); b.onMedia = receive
    await a.sendMedia(2, new Uint8Array(100))
    expect(receive).not.toHaveBeenCalled()
  })
  it('ignores strangers, rejects disabled calls, admits video as voice when only voice enabled', () => {
    eb.handler?.({ src: 'stranger', payload: encodeCallControl({ v: 1, type: 'offer', call_id: id }) })
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
    eb.handler?.({ src: 'a', payload: encodeCallControl({ v: 1, type: 'end', call_id: id }) })
    eb.handler?.({ src: 'a', payload: encodeCallControl({ v: 1, type: 'offer', call_id: id }) })
    expect(get(b.state)).toBeNull()
  })
  it('does not resume an old fragmented frame after a new call starts', async () => {
    a.start('Bob', ['b'], true); b.accept(true)
    let release!: () => void
    ea.gate = new Promise<void>(resolve => { release = resolve })
    const pending = a.sendMedia(2, jpeg(5000))
    const oldId = get(a.state)!.id
    a.end(); a.start('Bob', ['b'], true); b.accept(true)
    expect(get(a.state)?.id).not.toBe(oldId)
    release(); await pending
    expect(ea.sent.filter(bytes => bytes[0] === 73)).toHaveLength(1)
  })
  it('keeps rejected offers rejected after preferences are enabled', () => {
    b.dispose()
    let enabled = false
    b = new CallSession(eb, () => 'Alice', () => ({ voice: enabled, video: enabled }))
    const packet = encodeCallControl({ v: 1, type: 'offer', call_id: id })
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
  it('validates controls and bounds fragmented media by size, age, identity and sequence', () => {
    expect(parseCallControl(new TextEncoder().encode(JSON.stringify({ v: 1, type: 'offer', call_id: id, video: 'yes' })))).toBeNull()
    const receiver = new CallMediaReceiver()
    const parts = encodeCallMedia(id, 2, 1, jpeg(2500))
    expect(receiver.receive(id, parts[0], 0)).toBeNull()
    expect(receiver.receive(id, parts[1], 600)).toBeNull()
    expect(receiver.receive(id, parts[2], 600)).toBeNull()
    const fresh = encodeCallMedia(id, 2, 2, jpeg(2000))
    expect(receiver.receive(id, fresh[1], 610)).toBeNull()
    expect(receiver.receive(id, fresh[0], 610)?.bytes.length).toBe(2000)
    expect(receiver.receive(id, fresh[0], 620)).toBeNull()
    expect(receiver.receive('ff'.repeat(16), fresh[0], 620)).toBeNull()
    expect(encodeCallMedia(id, 2, 3, new Uint8Array(65537))).toHaveLength(0)
  })
})

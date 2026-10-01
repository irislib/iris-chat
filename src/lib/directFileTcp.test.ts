// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FipsDatagramEndpoint, FipsServiceContext } from '@fips/tcp'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  DIRECT_FILE_CHUNK_BYTES, DirectFileReader, DirectFileTcp, directFileFrame,
  type DirectFileEvent, type DirectFileSink, type DirectFileSource, type DirectFileTcpOptions,
} from './directFileTcp'

type Handler = (context: FipsServiceContext) => Promise<void> | void
class MemoryEndpoint implements FipsDatagramEndpoint {
  readonly handlers = new Map<number, Handler>()
  dropped = false
  sent = 0
  constructor(readonly id: string, private readonly network: Map<string, MemoryEndpoint>) {
    network.set(id.slice(2), this)
  }
  registerService(port: number, handler: Handler): () => void {
    this.handlers.set(port, handler)
    return () => this.handlers.delete(port)
  }
  async sendDatagram(args: { dst: string; srcPort?: number; dstPort: number; payload: Uint8Array }): Promise<void> {
    this.sent += 1
    expect(args.dst).toMatch(/^02[0-9a-f]{64}$/)
    const remote = this.network.get(args.dst.slice(2))
    if (this.dropped || remote?.dropped) return
    const handler = remote?.handlers.get(args.dstPort)
    if (!handler) return
    queueMicrotask(() => void handler({ src: this.id, srcPort: args.srcPort ?? 0,
      dstPort: args.dstPort, payload: args.payload.slice() }))
  }
}

const token = '9'.repeat(64)
const peers = ['a', 'b', 'c', 'd'].map(char => char.repeat(64))
const instances: DirectFileTcp[] = []
let network: Map<string, MemoryEndpoint>
function device(index: number, extra: Partial<DirectFileTcpOptions> = {}) {
  // Real FIPS datagrams expose either compressed parity after authentication,
  // unlike x-only signed offers and canonical even-parity send destinations.
  const endpoint = new MemoryEndpoint(`${index % 2 ? '03' : '02'}${peers[index]}`, network)
  const events: DirectFileEvent[] = []
  const tcp = new DirectFileTcp({ endpoint, localPeer: endpoint.id, onEvent: event => events.push(event),
    isnSeed: BigInt(index + 1), ...extra })
  instances.push(tcp)
  return { tcp, endpoint, events }
}
function source(filename: string, bytes: Uint8Array | string): DirectFileSource {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
  const hash = Array.from(sha256(data), byte => byte.toString(16).padStart(2, '0')).join('')
  return { filename, sizeBytes: data.length, sha256: hash, blob: new Blob([data.slice().buffer]) }
}
async function until(check: () => boolean, limit = 6000): Promise<void> {
  for (let elapsed = 0; elapsed < limit && !check(); elapsed += 10) await vi.advanceTimersByTimeAsync(10)
  expect(check()).toBe(true)
}
function last(events: DirectFileEvent[], type: DirectFileEvent['type']) {
  return events.findLast(event => event.type === type)
}
function diskSink() {
  const parts: BlobPart[] = []
  const sink: DirectFileSink = {
    write: vi.fn(async (chunk: Uint8Array) => { parts.push(chunk.slice().buffer) }),
    finish: vi.fn(async () => new Blob(parts)),
    abort: vi.fn(async () => { parts.length = 0 }),
  }
  return sink
}

beforeEach(() => { vi.useFakeTimers(); network = new Map() })
afterEach(async () => {
  await Promise.all(instances.splice(0).map(instance => instance.dispose()))
  vi.useRealTimers()
})

describe('DirectFileTcp native wire protocol', () => {
  it('uses native u32-BE framing and bounded incremental reassembly', () => {
    const frame = directFileFrame(1, Uint8Array.of(10, 20))
    expect(frame).toEqual(Uint8Array.of(0, 0, 0, 3, 1, 10, 20))
    const reader = new DirectFileReader()
    expect(reader.push(frame.slice(0, 5))).toEqual([])
    expect(reader.push(frame.slice(5))).toEqual([Uint8Array.of(1, 10, 20)])
    expect(() => reader.push(Uint8Array.of(0, 0, 128, 2))).toThrow(/frame size/)
  })

  it('reads no source bytes before acceptance, then streams multiple files and empty files exactly', async () => {
    const a = device(0)
    const b = device(1)
    const files = [source('hello.txt', 'Hello from a linked device'), source('empty', ''),
      source('binary.bin', Uint8Array.from({ length: 170_013 }, (_, i) => i % 251))]
    const read = vi.spyOn(files[2].blob, 'slice')
    a.tcp.registerOffer('multi', token, [peers[1]], files)
    await vi.advanceTimersByTimeAsync(100)
    expect(read).not.toHaveBeenCalled()
    expect(a.endpoint.sent).toBe(0)
    await b.tcp.receive('multi', token, peers[0], files)
    await until(() => !!last(a.events, 'completed') && !!last(b.events, 'completed'))
    const received = last(b.events, 'completed')!.files!
    expect(received.map(file => file.filename)).toEqual(files.map(file => file.filename))
    for (let index = 0; index < files.length; index++) {
      expect(new Uint8Array(await received[index].blob.arrayBuffer()))
        .toEqual(new Uint8Array(await files[index].blob.arrayBuffer()))
    }
    expect(read.mock.calls.every(([start, end]: [number?, number?, string?]) => Number(end) - Number(start) <= DIRECT_FILE_CHUNK_BYTES)).toBe(true)
    expect(a.events.filter(event => event.type === 'accepted')).toHaveLength(1)
    expect(last(a.events, 'failed')).toBeUndefined()
    expect(last(b.events, 'failed')).toBeUndefined()
  })

  it('rejects unauthorized devices and invalid capabilities without consuming the offer', async () => {
    const a = device(0); const b = device(1); const stranger = device(2); const wrongToken = device(3)
    const files = [source('private.txt', 'Only the accepting device gets this')]
    const read = vi.spyOn(files[0].blob, 'slice')
    a.tcp.registerOffer('private', token, [peers[1], peers[3]], files)
    await stranger.tcp.receive('private', token, peers[0], files)
    await until(() => !!last(stranger.events, 'failed'))
    expect(read).not.toHaveBeenCalled()
    await wrongToken.tcp.receive('private', '8'.repeat(64), peers[0], files)
    await until(() => !!last(wrongToken.events, 'failed'))
    expect(read).not.toHaveBeenCalled()
    await b.tcp.receive('private', token, peers[0], files)
    await until(() => !!last(b.events, 'completed'))
    expect(last(a.events, 'accepted')?.peer).toBe(peers[1])
  })

  it('allows distinct own-device identities and only the first accepting device gets bytes', async () => {
    const a = device(0); const b = device(1); const c = device(2)
    const files = [source('self.txt', 'A note to my other devices')]
    a.tcp.registerOffer('self', token, [peers[0], peers[1], peers[2]], files)
    await Promise.all([b.tcp.receive('self', token, peers[0], files), c.tcp.receive('self', token, peers[0], files)])
    await until(() => !!last(a.events, 'completed') &&
      [b, c].every(d => !!last(d.events, 'completed') || !!last(d.events, 'failed')))
    expect([b, c].filter(d => !!last(d.events, 'completed'))).toHaveLength(1)
    expect(a.events.filter(event => event.type === 'accepted')).toHaveLength(1)
    expect(() => a.tcp.registerOffer('self', token, [peers[1]], files)).toThrow(/already in use/)
    await expect(a.tcp.receive('same-device', token, peers[0], files)).rejects.toThrow(/another device/)
  })

  it('aborts local partial files and informs the sender when the receiver cancels', async () => {
    const sink = diskSink()
    const a = device(0); const b = device(1, { createReceiveFile: async () => sink })
    const files = [source('large.bin', new Uint8Array(2 * 1024 * 1024))]
    a.tcp.registerOffer('cancel', token, [peers[1]], files)
    await b.tcp.receive('cancel', token, peers[0], files)
    await until(() => vi.mocked(sink.write).mock.calls.length > 0)
    b.tcp.cancel('cancel')
    await until(() => !!last(a.events, 'cancelled') && !!last(b.events, 'cancelled'))
    expect(sink.abort).toHaveBeenCalledOnce()
    expect(last(b.events, 'completed')).toBeUndefined()
    expect(vi.mocked(sink.write).mock.calls.every(([chunk]: [Uint8Array]) => chunk.length <= DIRECT_FILE_CHUNK_BYTES)).toBe(true)
  })

  it('cleans all batch outputs, including already finished files, after a hash mismatch', async () => {
    const sinks: DirectFileSink[] = []
    const a = device(0); const b = device(1, { createReceiveFile: async () => {
      const sink = diskSink(); sinks.push(sink); return sink
    } })
    const files = [source('good.txt', 'good'), source('bad.txt', 'altered')]
    const expected = files.map(file => ({ ...file }))
    expected[1].sha256 = '0'.repeat(64)
    a.tcp.registerOffer('corrupt', token, [peers[1]], files)
    await b.tcp.receive('corrupt', token, peers[0], expected)
    await until(() => !!last(b.events, 'failed'))
    expect(last(b.events, 'failed')?.error).toMatch(/did not match/)
    expect(sinks).toHaveLength(2)
    expect(sinks[0].finish).toHaveBeenCalledOnce()
    for (const sink of sinks) expect(sink.abort).toHaveBeenCalledOnce()
    expect(last(b.events, 'completed')).toBeUndefined()
  })

  it('cancels from the sender and keeps terminal events stable on repeated cancellation', async () => {
    const sink = diskSink()
    const a = device(0); const b = device(1, { createReceiveFile: async () => sink })
    const files = [source('large.bin', new Uint8Array(2 * 1024 * 1024))]
    a.tcp.registerOffer('sender-cancel', token, [peers[1]], files)
    await b.tcp.receive('sender-cancel', token, peers[0], files)
    await until(() => vi.mocked(sink.write).mock.calls.length > 0)
    a.tcp.cancel('sender-cancel')
    await until(() => !!last(a.events, 'cancelled') && !!last(b.events, 'cancelled'))
    a.tcp.cancel('sender-cancel'); b.tcp.cancel('sender-cancel')
    expect(a.events.filter(event => event.type === 'cancelled')).toHaveLength(1)
    expect(b.events.filter(event => event.type === 'cancelled')).toHaveLength(1)
    expect(sink.abort).toHaveBeenCalledOnce()
    expect(last(b.events, 'completed')).toBeUndefined()
  })

  it('revokes an active accepting device and never expands the original permitted set', async () => {
    const a = device(0); const b = device(1); const c = device(2)
    const files = [source('large.bin', new Uint8Array(2 * 1024 * 1024))]
    a.tcp.registerOffer('revoke', token, [peers[1]], files)
    a.tcp.restrictOffer('revoke', [peers[1], peers[2]])
    await c.tcp.receive('revoke', token, peers[0], files)
    await until(() => !!last(c.events, 'failed'))
    await b.tcp.receive('revoke', token, peers[0], files)
    await until(() => !!last(a.events, 'accepted'))
    a.tcp.restrictOffer('revoke', [])
    await until(() => !!last(a.events, 'failed') && !!last(b.events, 'failed'))
    expect(last(a.events, 'failed')?.error).toMatch(/authorization changed/)
    expect(last(b.events, 'completed')).toBeUndefined()
  })

  it('declines without source reads and bounds the in-memory receiver before connecting', async () => {
    const a = device(0); const b = device(1)
    const files = [source('no.txt', 'Never read')]
    const read = vi.spyOn(files[0].blob, 'slice')
    a.tcp.registerOffer('decline', token, [peers[1]], files)
    await b.tcp.decline('decline', token, peers[0])
    await until(() => !!last(a.events, 'declined') && !!last(b.events, 'declined'))
    expect(read).not.toHaveBeenCalled()
    const sent = b.endpoint.sent
    await expect(b.tcp.receive('oversized', token, peers[0], [{ ...files[0], sizeBytes: 64 * 1024 * 1024 + 1 }]))
      .rejects.toThrow(/64 MB/)
    expect(b.endpoint.sent).toBe(sent)
  })

  it('times out a disconnected transfer and deletes partial output', async () => {
    const sink = diskSink()
    const a = device(0); const b = device(1, { createReceiveFile: async () => sink })
    const files = [source('large.bin', new Uint8Array(2 * 1024 * 1024))]
    a.tcp.registerOffer('timeout', token, [peers[1]], files)
    await b.tcp.receive('timeout', token, peers[0], files)
    await until(() => vi.mocked(sink.write).mock.calls.length > 0)
    b.endpoint.dropped = true
    vi.setSystemTime(Date.now() + 60_001)
    await until(() => !!last(b.events, 'failed'))
    expect(sink.abort).toHaveBeenCalledOnce()
    expect(last(b.events, 'completed')).toBeUndefined()
  })
})

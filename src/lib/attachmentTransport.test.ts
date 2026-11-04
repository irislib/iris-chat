// @vitest-environment node
// Exercise the installed TCP and Noise transports, including the identity the
// provider actually authenticates and the request bytes it actually receives.
import { afterEach, expect, it, vi } from 'vitest'
import { FipsNode, generateIdentity, toHex } from '@fips/core'
import { WebSocketTransport } from '@fips/transport-websocket'
import { FipsTcpEndpoint, type ConnectionId } from '@fips/tcp'
import { MemoryStore, sha256, type Hash, type Store } from '@hashtree/core'
import { TcpBlobTransport } from '@hashtree/fips-transport'
import { WebSocket } from 'ws'
import { startLocalFipsWebSocketSeed } from '../../e2e/fixtures/localFipsWebSocketSeed'
import { createAttachmentTransport } from './attachmentTransport'
import { normalizeDeviceSyncPeer } from './deviceSyncTcp'

const PORT = 39018
const emptyStore = (): Store => ({ get: async () => null, put: async () => false,
  has: async () => false, delete: async () => false })
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 5))
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.unstubAllGlobals()
})

async function network(count: number) {
  vi.stubGlobal('WebSocket', WebSocket)
  const seed = await startLocalFipsWebSocketSeed()
  cleanups.push(() => seed.close())
  const nodes: FipsNode[] = []
  for (let index = 0; index < count; index++) {
    const node = new FipsNode({ identity: await generateIdentity(), forwarding: false,
      routingMode: 'reply_learned', transports: [new WebSocketTransport({ seedUrls: [seed.url] })] })
    cleanups.push(() => node.stop())
    await node.start(); nodes.push(node)
  }
  await vi.waitFor(() => expect(seed.connectedPeers()).toHaveLength(count), { timeout: 5000 })
  return { seed, nodes }
}

/** An independent TCP server observes the full serialized application request. */
function observeProvider(node: FipsNode, blocks: Map<string, Uint8Array>) {
  const tcp = new FipsTcpEndpoint(node, PORT)
  const requests: { peer: string; wire: Uint8Array }[] = []
  const tasks = new Set<Promise<void>>()
  let closed = false, pumping = false, rejectNext = false, hold = false
  const serve = async (connection: ConnectionId) => {
    const peer = (await tcp.peer(connection))!
    const chunks: Uint8Array[] = []; let length = 0
    const deadline = Date.now() + 5000
    while (!closed && length < 36 && Date.now() < deadline) {
      const bytes = await tcp.read(connection, 36 - length)
      chunks.push(bytes); length += bytes.length
      if (length < 36) await pause()
    }
    if (closed || length !== 36) return
    const wire = new Uint8Array(36); let offset = 0
    for (const chunk of chunks) { wire.set(chunk, offset); offset += chunk.length }
    requests.push({ peer, wire })
    if (rejectNext) { rejectNext = false; await tcp.abort(connection); return }
    if (hold) return
    const data = blocks.get(toHex(wire.slice(4)))
    const reply = new Uint8Array(7 + (data?.length ?? 0))
    reply.set([0x48, 1, data ? 1 : 0])
    new DataView(reply.buffer).setUint32(3, data?.length ?? 0)
    if (data) reply.set(data, 7)
    await tcp.write(connection, reply)
    await tcp.close(connection)
  }
  const timer = setInterval(() => {
    if (closed || pumping) return
    pumping = true
    void (async () => {
      await tcp.poll()
      for (;;) {
        const connection = await tcp.accept()
        if (connection === undefined) break
        const task = serve(connection).catch(() => undefined)
        tasks.add(task); void task.finally(() => tasks.delete(task))
      }
    })().catch(() => undefined).finally(() => { pumping = false })
  }, 5)
  cleanups.push(async () => {
    closed = true; clearInterval(timer)
    await Promise.allSettled([...tasks])
    while (pumping) await pause()
    await tcp.dispose()
  })
  return { requests, rejectNext: () => { rejectNext = true }, hold: () => { hold = true } }
}

it('keeps provider requests anonymous on real wire retries, restart, and shutdown', async () => {
  const { seed, nodes: [device, provider, attacker] } = await network(3)
  const owner = await generateIdentity(), deviceKey = toHex(device.identity.publicKey)
  const bytes = new TextEncoder().encode('encrypted attachment fixture'), hash = await sha256(bytes)
  const server = observeProvider(provider, new Map([[toHex(hash), bytes]]))
  const store = new MemoryStore()
  const providerKey = toHex(provider.identity.publicKey)
  const identifiedSend = vi.spyOn(device, 'sendDatagram')
  const makeReader = () => createAttachmentTransport({ endpoint: device, store,
    // An unrelated peer in this list still must never receive identified reads.
    siblings: () => [providerKey], allowSibling: () => false,
    providers: { servers: [seed.url], peers: () => [providerKey] } })
  const first = makeReader(); cleanups.push(() => first.close())
  server.rejectNext()
  expect(await first.get(hash)).toEqual(bytes)
  expect(server.requests).toHaveLength(2)
  const anonymous = server.requests[0]!.peer
  const expected = new Uint8Array(36); expected.set([0x48, 1, 1, 0]); expected.set(hash, 4)
  for (const request of server.requests) {
    expect(request.wire).toEqual(expected)
    expect(request.peer).toBe(anonymous)
    expect(request.peer.slice(2)).not.toBe(deviceKey.slice(2))
    expect(request.peer.slice(2)).not.toBe(toHex(owner.xOnlyPubkey))
  }
  // The anonymous endpoint cannot expose the identified endpoint's cache, even
  // when an unrelated provider already knows the exact hash to probe.
  await store.put(hash, bytes)
  const probe = new TcpBlobTransport({ endpoint: attacker, localStore: emptyStore(), timeoutMs: 600 })
  cleanups.push(() => probe.close())
  await expect(probe.get(hash, [anonymous], 0)).rejects.toThrow()
  await probe.close()
  await first.close()
  await vi.waitFor(() => expect(seed.connectedPeers().map(normalizeDeviceSyncPeer))
    .not.toContain(normalizeDeviceSyncPeer(anonymous)), { timeout: 5000 })
  const second = makeReader(); cleanups.push(() => second.close())
  // Keep the source cache out of this read so the remote wire is exercised.
  await store.delete(hash)
  expect(await second.get(hash)).toEqual(bytes)
  expect(server.requests).toHaveLength(3)
  expect(server.requests[2]!.peer.slice(2)).not.toBe(anonymous.slice(2))
  expect(server.requests[2]!.peer.slice(2)).not.toBe(deviceKey.slice(2))
  server.hold()
  const pending = second.get(hash).catch(() => null)
  await vi.waitFor(() => expect(server.requests).toHaveLength(4), { timeout: 5000 })
  await second.close()
  expect(await pending).toBeNull()
  const count = server.requests.length
  expect(await second.get(hash)).toBeNull()
  await pause()
  expect(server.requests).toHaveLength(count)
  expect(identifiedSend).not.toHaveBeenCalled()
}, 30000)

it('denies unrelated cache probes and preserves only dynamically authorized sibling reads', async () => {
  const { nodes: [holder, sibling, unrelated] } = await network(3)
  const siblingKey = normalizeDeviceSyncPeer(toHex(sibling.identity.publicKey))
  const holderKey = toHex(holder.identity.publicKey)
  const allowed = new Set([siblingKey])
  const store = new MemoryStore(), bytes = new Uint8Array([17, 23, 42]), hash = await sha256(bytes)
  await store.put(hash, bytes)
  const reads = vi.spyOn(store, 'get')
  const service = createAttachmentTransport({ endpoint: holder, store,
    siblings: () => [], allowSibling: peer => allowed.has(peer) })
  cleanups.push(() => service.close())
  const makeClient = (node: FipsNode) => {
    const client = new TcpBlobTransport({ endpoint: node, localStore: emptyStore(), timeoutMs: 600 })
    cleanups.push(() => client.close()); return client
  }
  const outsider = makeClient(unrelated)
  for (const requested of [hash, new Uint8Array(32) as Hash]) {
    await expect(outsider.get(requested, [holderKey], 0)).rejects.toThrow()
  }
  expect(reads).not.toHaveBeenCalled()
  const own = makeClient(sibling)
  expect(await own.get(hash, [holderKey], 0)).toEqual(bytes)
  expect(reads).toHaveBeenCalled()
  reads.mockClear(); allowed.clear()
  await expect(own.get(hash, [holderKey], 0)).rejects.toThrow()
  expect(reads).not.toHaveBeenCalled()
  allowed.add(siblingKey)
  expect(await own.get(hash, [holderKey], 0)).toEqual(bytes)
  // Revocation must also cover a request already admitted before the cache read
  // completes; no response may leave the now-unauthorized identified endpoint.
  let release!: (value: Uint8Array | null) => void
  reads.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const inFlight = own.get(hash, [holderKey], 0).catch(() => null)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  allowed.clear(); release(bytes)
  expect(await inFlight).toBeNull()
}, 15000)

// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { FipsNode, fromHex, identityFromSecretKey, toHex } from '@fips/core'
import type { FipsIdentity, Transport, TransportAddress, TransportContext } from '@fips/core'
import type { FspSession } from '../../node_modules/@fips/core/dist/fsp/session.js'
import type { AdjacentPeer } from '../../node_modules/@fips/core/dist/node/PeerState.js'

// Public vectors used by the shared runtime's Noise parity tests.
const oddSecret = fromHex('b102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1fb0')
const evenSecret = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20')
const nodes: FipsNode[] = []

class MemoryCarrier implements Transport {
  readonly mtu = 1200
  context?: TransportContext
  counterpart!: MemoryCarrier
  packets = 0
  usable = true
  constructor(readonly type: string, readonly remoteAddr: TransportAddress) {}
  async start(context: TransportContext) { this.context = context }
  async stop() { this.context = undefined }
  async connect() {}
  async send(_address: TransportAddress, data: Uint8Array) {
    if (!this.usable) throw new Error('carrier disconnected')
    this.packets += 1
    this.counterpart.context!.onPacket({
      transportType: this.type,
      remoteAddr: this.counterpart.remoteAddr,
      data: data.slice(),
      receivedAtMs: Date.now(),
    })
  }
  disconnect() {
    this.usable = false
    this.context!.onConnectionState?.({ remoteAddr: this.remoteAddr, state: 'disconnected' })
  }
}

function pair(type: string, local: FipsIdentity, remote: FipsIdentity, canonical: boolean) {
  const key = (identity: FipsIdentity) => canonical ? `02${toHex(identity.xOnlyPubkey)}` : toHex(identity.publicKey)
  const a = new MemoryCarrier(type, { transport: type, addr: key(remote) })
  const b = new MemoryCarrier(type, { transport: type, addr: key(local) })
  a.counterpart = b; b.counterpart = a
  return [a, b] as const
}

interface NodeState {
  peersByPubkey: Map<string, AdjacentPeer>
  peersByNodeAddr: Map<string, AdjacentPeer>
  sessionManager: { sessions: Map<string, { fsp: FspSession }> }
}
const inspect = (node: FipsNode) => node as unknown as NodeState
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }

async function fixture(parity: 'odd' | 'even', unrelatedWebSocket = false) {
  const localIdentity = await identityFromSecretKey(evenSecret)
  const evenControlSecret = new Uint8Array(32); evenControlSecret[31] = 1
  const remoteIdentity = await identityFromSecretKey(parity === 'odd' ? oddSecret : evenControlSecret)
  const wsIdentity = unrelatedWebSocket
    ? await identityFromSecretKey(new Uint8Array(32).fill(0x42)) : remoteIdentity
  const [localWs, remoteWs] = pair('websocket', localIdentity, wsIdentity, false)
  const [localRtc, remoteRtc] = pair('webrtc', localIdentity, remoteIdentity, true)
  const local = new FipsNode({ identity: localIdentity, transports: [localWs, localRtc] })
  const remote = new FipsNode({ identity: remoteIdentity, transports: unrelatedWebSocket ? [remoteRtc] : [remoteWs, remoteRtc] })
  nodes.push(local, remote)
  const wsNode = unrelatedWebSocket ? new FipsNode({ identity: wsIdentity, transports: [remoteWs] }) : remote
  if (unrelatedWebSocket) nodes.push(wsNode)
  const receivedLocal: number[] = [], receivedRemote: number[] = []
  local.registerService(4242, ({ payload }) => { receivedLocal.push(payload[0]) })
  remote.registerService(4242, ({ payload }) => { receivedRemote.push(payload[0]) })
  await Promise.all(nodes.map(node => node.start()))
  // Incoming WS Noise learns actual parity; outgoing RTC uses discovery's02 key.
  await wsNode.connect(remoteWs.remoteAddr)
  const destination = `02${toHex(remoteIdentity.xOnlyPubkey)}`
  if (!unrelatedWebSocket) {
    await local.sendDatagram({ dst: destination, dstPort: 4242, payload: new Uint8Array([1]) })
    await settle()
    expect(receivedRemote).toEqual([1])
  }
  await local.connect(localRtc.remoteAddr)
  await local.sendDatagram({ dst: destination, dstPort: 4242, payload: new Uint8Array([2]) })
  await settle()
  expect(receivedRemote.at(-1)).toBe(2)
  return { local, remote, localWs, localRtc, remoteRtc, receivedLocal, receivedRemote,
    destination, localIdentity, remoteIdentity }
}

afterEach(async () => {
  await Promise.all(nodes.splice(0).map(node => node.stop()))
})

describe('FIPS alternate carrier identity', () => {
  it.each(['odd', 'even'] as const)('preserves the authenticated %s-key session and WS delivery when RTC disconnects', async (parity: 'odd' | 'even') => {
    const f = await fixture(parity)
    const state = inspect(f.local)
    const nodeHex = toHex(f.remoteIdentity.nodeAddr)
    const session = state.sessionManager.sessions.get(nodeHex)!
    const rtc = state.peersByNodeAddr.get(nodeHex)!
    const ws = state.peersByPubkey.get(toHex(f.remoteIdentity.publicKey))!
    expect(rtc.transport.type).toBe('webrtc')
    expect(session.fsp.state).toBe('established')
    if (parity === 'odd') expect(ws.pubkey[0]).not.toBe(rtc.pubkey[0])

    f.localRtc.disconnect(); f.remoteRtc.disconnect()

    expect(state.sessionManager.sessions.get(nodeHex) === session).toBe(true)
    expect(session.fsp.state).toBe('established')
    expect(state.peersByNodeAddr.get(nodeHex)?.transport.type).toBe('websocket')
    expect([...state.peersByPubkey.values()]).not.toContain(rtc)
    const before = f.localWs.packets
    await f.local.sendDatagram({ dst: f.destination, dstPort: 4242, payload: new Uint8Array([3]) })
    await f.remote.sendDatagram({ dst: toHex(f.localIdentity.publicKey), dstPort: 4242, payload: new Uint8Array([4]) })
    await settle()
    expect(f.receivedRemote.at(-1)).toBe(3)
    expect(f.receivedLocal.at(-1)).toBe(4)
    expect(f.localWs.packets).toBeGreaterThan(before)
  })

  it('does not treat a different authenticated WS identity as the lost RTC peer', async () => {
    const f = await fixture('odd', true)
    const state = inspect(f.local)
    const nodeHex = toHex(f.remoteIdentity.nodeAddr)
    const session = state.sessionManager.sessions.get(nodeHex)!
    f.localRtc.disconnect(); f.remoteRtc.disconnect()
    expect(state.sessionManager.sessions.has(nodeHex)).toBe(false)
    expect(session.fsp.state).toBe('closed')
    expect(state.peersByNodeAddr.has(nodeHex)).toBe(false)
    expect([...state.peersByNodeAddr.values()].some(peer => peer.transport.type === 'websocket')).toBe(true)
  })
})

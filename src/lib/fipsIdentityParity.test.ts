// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { fromHex, identityFromSecretKey, toHex, deriveNodeAddr } from '@fips/core'
import { FspSession } from '../../node_modules/@fips/core/dist/fsp/session.js'
import { FspSessionManager } from '../../node_modules/@fips/core/dist/node/FspSessionManager.js'
import { FSP_FLAG_K, peekFspPhase } from '../../node_modules/@fips/core/dist/fsp/wire.js'
import { FmpLink } from '../../node_modules/@fips/core/dist/fmp/link.js'
import { FmpTransportPacketProcessor } from '../../node_modules/@fips/core/dist/node/FmpTransportPacketProcessor.js'
import { transportAddressKey, type Transport } from '../../node_modules/@fips/core/dist/transport/types.js'
import type { AdjacentPeer } from '../../node_modules/@fips/core/dist/node/PeerState.js'

// Public test-vector secrets from the shared runtime's Noise parity regression.
const oddSecret = fromHex('b102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1fb0')
const evenSecret = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20')

async function fixture(parity: 'even' | 'odd' = 'odd') {
  const local = await identityFromSecretKey(parity === 'odd' ? evenSecret : oddSecret)
  const remote = await identityFromSecretKey(parity === 'odd' ? oddSecret : evenSecret)
  expect(remote.publicKey[0]).toBe(parity === 'odd' ? 3 : 2)
  const advertised = Uint8Array.from(remote.publicKey); advertised[0] = 2
  const localEpoch = new Uint8Array(8).fill(1), remoteEpoch = new Uint8Array(8).fill(2)
  const link = new FmpLink({ identity: local, role: 'initiator', remotePubkey: advertised, localEpoch, sessionIdx: 1 })
  const original = new FmpLink({ identity: remote, role: 'responder', localEpoch: remoteEpoch, sessionIdx: 2 })
  const response = original.handleMsg1(link.buildMsg1(n => crypto.getRandomValues(new Uint8Array(n))).packet, n => crypto.getRandomValues(new Uint8Array(n)))
  link.handleMsg2(response.reply!)
  expect(link.state).toBe('established')
  const errors: Error[] = [], sent: Uint8Array[] = []
  const remoteAddr = { transport: 'memory', addr: toHex(advertised) }
  const transport = { type: 'memory', mtu: 1200, send: async (_address: unknown, packet: Uint8Array) => { sent.push(packet) } } as unknown as Transport
  const peer: AdjacentPeer = { pubkey: advertised, pubkeyHex: toHex(advertised), remoteAddr, transport, link }
  const peers = new Map([[transportAddressKey(remoteAddr), peer]])
  const delivered = vi.fn(async () => {})
  const removePeerPath = vi.fn()
  let nextSessionIdx = 10
  const processor = new FmpTransportPacketProcessor({
    identity: local, startupEpoch: localEpoch, nextSessionIdx: () => nextSessionIdx++, randomBytes: n => crypto.getRandomValues(new Uint8Array(n)),
    logger: { debug() {}, info() {}, warn() {}, error() {} }, peers,
    peersByPubkey: new Map([[peer.pubkeyHex, peer]]), peersByNodeAddr: new Map([[toHex(deriveNodeAddr(advertised)), peer]]),
    routing: { scheduleTreeAnnounce() {}, handleLinkMessage: delivered } as never,
    sessionManager: { closePeerSessions() {} } as never,
    removePeerPath,
    emitError: error => errors.push(error), emitPeer() {}, handlePeerRestart() {},
  })
  const receive = (data: Uint8Array) => processor.process(transport, { remoteAddr, transportType: 'memory', data, receivedAtMs: Date.now() })
  return { local, remote, remoteEpoch, original, peer, errors, sent, receive, delivered, removePeerPath }
}

describe('authenticated FIPS identity parity', () => {
  it.each(['odd', 'even'] as const)('accepts a new Noise link from the same x-only identity with its actual %s parity', async (parity: 'odd' | 'even') => {
    const f = await fixture(parity)
    const replacement = new FmpLink({ identity: f.remote, role: 'initiator', remotePubkey: f.local.publicKey, localEpoch: f.remoteEpoch, sessionIdx: 3 })
    f.receive(replacement.buildMsg1(n => crypto.getRandomValues(new Uint8Array(n))).packet)
    expect(f.errors).toEqual([])
    expect(f.sent).toHaveLength(1)
    replacement.handleMsg2(f.sent[0])
    const payload = new Uint8Array([17, 23, 41])
    f.receive(replacement.encryptOutgoing(payload))
    expect(f.errors).toEqual([])
    expect(f.delivered).toHaveBeenCalledWith(f.peer, expect.any(Number), payload)
    expect(f.peer.link.role).toBe('responder')
    expect(f.removePeerPath).not.toHaveBeenCalled()
  })
  it('still rejects a different authenticated x-only identity on the established address', async () => {
    const f = await fixture()
    const attacker = await identityFromSecretKey(new Uint8Array(32).fill(0x42))
    const replacement = new FmpLink({ identity: attacker, role: 'initiator', remotePubkey: f.local.publicKey, localEpoch: f.remoteEpoch, sessionIdx: 3 })
    f.receive(replacement.buildMsg1(n => crypto.getRandomValues(new Uint8Array(n))).packet)
    expect(f.errors).toHaveLength(1)
    expect(f.errors[0].message).toMatch(/changed the authenticated peer identity/)
    expect(f.sent).toHaveLength(0)
    // Rejection must leave the authenticated, established carrier usable.
    f.receive(f.original.encryptOutgoing(new Uint8Array([7])))
    expect(f.delivered).toHaveBeenCalledWith(f.peer, expect.any(Number), new Uint8Array([7]))
    expect(f.removePeerPath).not.toHaveBeenCalled()
  })
})


describe('authenticated FSP rekey identity parity', () => {
  it.each([['odd', false], ['even', false], ['odd', true], ['odd', 'collision']] as const)('checks a reverse rekey with %s parity (different identity: %s)', async (parity: 'odd' | 'even', differentIdentity: boolean | 'collision') => {
    const local = await identityFromSecretKey(parity === 'odd' ? evenSecret : oddSecret)
    const remote = await identityFromSecretKey(parity === 'odd' ? oddSecret : evenSecret)
    const advertised = Uint8Array.from(remote.publicKey); advertised[0] = 2
    const peer = { pubkey: remote.publicKey, pubkeyHex: toHex(remote.publicKey) } as never
    const remoteEpoch = new Uint8Array(8).fill(2)
    let original: FspSession
    const replies: Uint8Array[] = [], delivered: Uint8Array[] = []
    const random = (n: number) => crypto.getRandomValues(new Uint8Array(n))
    const manager = new FspSessionManager({
      identity: local, localEpoch: new Uint8Array(8).fill(1), random: { bytes: random },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      routing: {
        coords: [local.nodeAddr], coordinatesFor: () => [remote.nodeAddr], learnReverseRoute() {},
        hasUsableRoute: () => true,
        sendFspToward: async (_: Uint8Array, frame: Uint8Array) => {
          if (peekFspPhase(frame) === 1) {
            original = new FspSession({ identity: remote, role: 'responder', localEpoch: remoteEpoch })
            const ack = original.handleSessionSetup(frame, random, [remote.nodeAddr])
            await manager.handleFromPeer(peer, remote.nodeAddr, ack)
          } else if (peekFspPhase(frame) === 3) original.handleSessionMsg3(frame)
        },
        sendFspReplyToward: async (_: Uint8Array, frame: Uint8Array) => { replies.push(frame) },
      } as never,
      getPeerByNodeAddr: () => undefined, emitDatagram() {}, emitEndpointData() {},
      handleLinkNegotiation: async () => {}, emitSession() {},
    })
    manager.registerService(4242, ({ payload }) => { delivered.push(payload) })
    try {
      await manager.sendDatagram({ dst: toHex(advertised), dstPort: 4242, payload: new Uint8Array([1]) })
      const candidate = differentIdentity === true ? await identityFromSecretKey(new Uint8Array(32).fill(0x42)) : remote
      const replacement = new FspSession({ identity: candidate, role: 'initiator', remotePubkey: local.publicKey, localEpoch: remoteEpoch })
      await manager.handleFromPeer(peer, remote.nodeAddr, replacement.buildSessionSetup(random, [remote.nodeAddr], [local.nodeAddr]))
      const final = replacement.handleSessionAck(replies[0], random)
      if (differentIdentity) {
        if (differentIdentity === 'collision') {
          // Model two full keys sharing a routing address without needing to find
          // a hash collision: the established binding must reject a new key even
          // after the shorter NodeAddr check succeeds.
          const sessions = (manager as unknown as { sessions: Map<string, { remotePubkey: Uint8Array }> }).sessions
          sessions.get(toHex(remote.nodeAddr))!.remotePubkey = (await identityFromSecretKey(new Uint8Array(32).fill(0x42))).publicKey
        }
        await expect(manager.handleFromPeer(peer, remote.nodeAddr, final)).rejects.toThrow(differentIdentity === 'collision'
          ? 'FSP rekey changed the authenticated remote identity' : 'authenticated key does not match claimed source NodeAddr')
        await expect(manager.handleFromPeer(peer, remote.nodeAddr, replacement.encryptDatagram({ srcPort: 4242, dstPort: 4242, payload: new Uint8Array([99]) }, FSP_FLAG_K)))
          .rejects.toThrow('FSP Established epoch mismatch')
        const payload = new Uint8Array([7])
        await manager.handleFromPeer(peer, remote.nodeAddr, original!.encryptDatagram({ srcPort: 4242, dstPort: 4242, payload }))
        expect(delivered).toEqual([payload])
        return
      }
      await expect(manager.handleFromPeer(peer, remote.nodeAddr, final)).resolves.toBeUndefined()
      const payload = new Uint8Array([17, 23, 41])
      await manager.handleFromPeer(peer, remote.nodeAddr, replacement.encryptDatagram({ srcPort: 4242, dstPort: 4242, payload }, FSP_FLAG_K))
      expect(delivered).toEqual([payload])
    } finally { manager.stop() }
  })
})

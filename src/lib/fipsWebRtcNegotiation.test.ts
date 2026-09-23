// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebRtcTransport } from '@fips/transport-webrtc'
import { identityFromSecretKey } from '@fips/core'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

class FakeDataChannel extends EventTarget {
  readyState = 'connecting'
  binaryType = 'arraybuffer'
  sent: Uint8Array[] = []
  send(data: Uint8Array) { this.sent.push(new Uint8Array(data)) }
  close() {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.dispatchEvent(new Event('close'))
  }
}

class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = []
  static offerGate: ReturnType<typeof deferred<RTCSessionDescriptionInit>> | undefined
  static localGate: ReturnType<typeof deferred<void>> | undefined
  connectionState = 'new'
  iceConnectionState = 'new'
  iceGatheringState = 'gathering'
  signalingState = 'stable'
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  ondatachannel?: (event: { channel: FakeDataChannel }) => void
  channel = new FakeDataChannel()
  setLocalCalls = 0
  private readonly initiator = FakePeerConnection.instances.length === 0

  constructor() {
    super()
    FakePeerConnection.instances.push(this)
    if (!this.initiator) this.iceGatheringState = 'complete'
  }

  createDataChannel() { return this.channel }
  async createOffer() {
    return FakePeerConnection.offerGate?.promise ?? { type: 'offer', sdp: 'outgoing-sdp' }
  }
  async createAnswer() { return { type: 'answer', sdp: 'incoming-answer-sdp' } }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.setLocalCalls += 1
    if (this.initiator) await FakePeerConnection.localGate?.promise
    this.localDescription = description
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description
  }
  close() {
    if (this.connectionState === 'closed') return
    this.connectionState = 'closed'
    this.iceConnectionState = 'closed'
    this.channel.close()
    this.dispatchEvent(new Event('connectionstatechange'))
  }
  finishGathering() {
    this.iceGatheringState = 'complete'
    this.dispatchEvent(new Event('icegatheringstatechange'))
  }
  connectChannel() {
    this.connectionState = 'connected'
    this.iceConnectionState = 'connected'
    this.channel.readyState = 'open'
    this.channel.dispatchEvent(new Event('open'))
    this.channel.dispatchEvent(new MessageEvent('message', {
      data: new Uint8Array([0xff, 0x46, 0x57, 0x52, 0x31]).buffer,
    }))
    this.dispatchEvent(new Event('connectionstatechange'))
  }
}

const remote = { transport: 'webrtc', addr: '' }
const transports: WebRtcTransport[] = []
const flush = () => vi.advanceTimersByTimeAsync(0)

async function fixture(sendGate?: ReturnType<typeof deferred<void>>, localScalar = 2, remoteScalar = 1) {
  const secret = (scalar: number) => {
    const bytes = new Uint8Array(32)
    bytes[31] = scalar
    return bytes
  }
  const identities = await Promise.all([remoteScalar, localScalar].map(value => identityFromSecretKey(secret(value))))
  remote.addr = `02${Buffer.from(identities[0].xOnlyPubkey).toString('hex')}`
  const sent: Array<{ kind: string; negotiationId: string }> = []
  const states: string[] = []
  const transport = new WebRtcTransport({
    rtcPeerConnection: FakePeerConnection as unknown as typeof RTCPeerConnection,
    acceptConnections: true,
    iceGatherTimeoutMs: 2_000,
  })
  transports.push(transport)
  await transport.start({
    localIdentity: identities[1],
    onPacket: vi.fn(),
    onConnectionState: event => states.push(event.state),
    sendLinkNegotiation: async (_peer, signal) => {
      sent.push({ kind: signal.kind, negotiationId: signal.negotiationId })
      if (signal.kind === 'offer') await sendGate?.promise
    },
  })
  const result = transport.connect(remote).then(() => 'connected', error => error.message as string)
  await flush()
  return { transport, sent, states, result }
}

async function incomingWins(transport: WebRtcTransport) {
  await transport.handleLinkNegotiation(remote.addr, {
    version: 1,
    negotiationId: 'winning-incoming-offer',
    linkType: 'webrtc',
    kind: 'offer',
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    payload: { sdp: 'incoming-sdp' },
  })
  const replacement = FakePeerConnection.instances[1]
  replacement.ondatachannel?.({ channel: replacement.channel })
  await flush()
  replacement.connectChannel()
  await flush()
  return replacement
}

beforeEach(() => {
  vi.useFakeTimers()
  FakePeerConnection.instances = []
  FakePeerConnection.offerGate = undefined
  FakePeerConnection.localGate = undefined
})

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.stop()
  vi.useRealTimers()
})

describe('WebRTC simultaneous negotiation ownership', () => {
  it.each([[22, 1, false], [1, 22, true], [22, 22, false]] as const)(
    'uses full x-only ordering for local scalar%s versus remote scalar%s',
    async (localScalar: number, remoteScalar: number, accept: boolean) => {
      const { transport, sent } = await fixture(undefined, localScalar, remoteScalar)
      await transport.handleLinkNegotiation(remote.addr, {
        version: 1, negotiationId: 'parity-ordering-offer', linkType: 'webrtc', kind: 'offer',
        createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
        payload: { sdp: 'incoming-sdp' },
      })
      expect(sent.map(signal => signal.kind)).toEqual([accept ? 'answer' : 'reject'])
      expect(FakePeerConnection.instances).toHaveLength(accept ? 2 : 1)
    },
  )

  it('does not send a canceled offer or remove the winning connection after slow ICE gathering', async () => {
    const { transport, sent, states, result } = await fixture()
    const replacement = await incomingWins(transport)
    expect(await result).toBe('incoming WebRTC offer won simultaneous dial')
    expect(states).toContain('connected')

    await vi.advanceTimersByTimeAsync(2_000)

    expect(sent.map(signal => signal.kind)).toEqual(['answer'])
    expect(states).not.toContain('failed')
    expect(states).not.toContain('disconnected')
    await transport.send(remote, new Uint8Array([42]))
    expect(replacement.channel.sent.at(-1)).toEqual(new Uint8Array([42]))
  })

  it('stops a canceled createOffer continuation before setting its local description', async () => {
    const gate = deferred<RTCSessionDescriptionInit>()
    FakePeerConnection.offerGate = gate
    const { transport, sent } = await fixture()
    await incomingWins(transport)
    gate.resolve({ type: 'offer', sdp: 'canceled-sdp' })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(FakePeerConnection.instances[0].setLocalCalls).toBe(0)
    expect(sent.map(signal => signal.kind)).toEqual(['answer'])
  })

  it('stops a canceled setLocalDescription continuation', async () => {
    const gate = deferred<void>()
    FakePeerConnection.localGate = gate
    const { transport, sent } = await fixture()
    await incomingWins(transport)
    gate.resolve()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(sent.map(signal => signal.kind)).toEqual(['answer'])
  })

  it('does not install stale connection callbacks after a pending offer send resolves', async () => {
    const gate = deferred<void>()
    const { transport, sent, states } = await fixture(gate)
    FakePeerConnection.instances[0].finishGathering()
    await flush()
    expect(sent.map(signal => signal.kind)).toEqual(['offer'])
    const replacement = await incomingWins(transport)
    gate.resolve()
    await flush()
    expect(states).not.toContain('failed')
    await transport.send(remote, new Uint8Array([43]))
    expect(replacement.channel.sent.at(-1)).toEqual(new Uint8Array([43]))
  })

  it('ignores close callbacks from an already wired dial when an incoming offer wins', async () => {
    const { transport, states } = await fixture()
    FakePeerConnection.instances[0].finishGathering()
    await flush()
    await incomingWins(transport)
    expect(states).toEqual(['connected'])
    await transport.send(remote, new Uint8Array([44]))
  })

  it('still reports a genuine failure for the current outgoing dial', async () => {
    const { states, result } = await fixture()
    const current = FakePeerConnection.instances[0]
    current.finishGathering()
    await flush()
    current.connectionState = 'failed'
    current.iceConnectionState = 'failed'
    current.dispatchEvent(new Event('connectionstatechange'))
    await flush()
    expect(await result).toBe('webrtc state failed')
    expect(states).toContain('failed')
  })
})

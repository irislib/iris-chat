import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type VerifiedEvent } from 'nostr-tools'
import { Session, Invite, AppKeys, type Rumor } from 'nostr-double-ratchet'
import { awaitsCallWake, callWakeEvent, envelopeRecipientDevice, observeCallWakeInvite, queuedCallWakeEnvelope, acceptedCallWakeBootstrap, sendCallWakeups } from './callPush'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
function sessions() {
  const a = generateSecretKey(), b = generateSecretKey(), shared = generateSecretKey()
  return [Session.init(getPublicKey(b), a, true, shared), Session.init(getPublicKey(a), b, false, shared)] as const
}
it('wraps only real ratchet ciphertext, which the peer session alone opens', () => {
  const [sender, receiver] = sessions()
  const device = generateSecretKey(), target = getPublicKey(generateSecretKey())
  const clear = { kind: 21112, pubkey: getPublicKey(device), content: JSON.stringify({ v: 3, type: 'offer', call_id: '12'.repeat(16), video: true, muted: false, codec: 'opus-h264-v3' }) }
  const encrypted = sender.sendEvent(clear)
  // The message names nobody; only the wake around it names the device to ring.
  expect(encrypted.event.tags.map(tag => tag[0])).toEqual(['v', 'header'])
  const wake = callWakeEvent(target, encrypted.event)
  expect(verifyEvent(wake)).toBe(true)
  expect(wake.kind).toBe(21111)
  expect(wake.tags).toEqual([['p', target]])
  expect(wake.content).not.toContain('call_id')
  expect(wake.content).not.toContain('opus-h264')
  const wrapper = JSON.parse(wake.content)
  expect(wrapper).toEqual({ type: 'call-wake', v: 3, events: [JSON.parse(JSON.stringify(encrypted.event))] })
  expect(JSON.stringify(wake)).not.toContain(getPublicKey(device))
  expect(JSON.stringify(wrapper.events[0])).not.toContain(target)
  expect(wake.pubkey).not.toBe(encrypted.event.pubkey)
  expect(callWakeEvent(target, encrypted.event).pubkey).not.toBe(wake.pubkey)
  expect(receiver.receiveEvent(wrapper.events[0])).toMatchObject(clear)
  // An envelope in the shape older versions sent names its recipient and is never wrapped.
  const tagged = finalizeEvent({ kind: 1060, created_at: encrypted.event.created_at, content: encrypted.event.content,
    tags: [...encrypted.event.tags, ['p', target]] }, generateSecretKey())
  expect(() => callWakeEvent(target, tagged)).toThrow('Invalid')
  expect(() => callWakeEvent('not-a-device', encrypted.event)).toThrow('Invalid')
})
it('keeps the first reply to a public invite unlinkable when it carries a call wake', () => {
  const inviterKey = generateSecretKey(), inviter = getPublicKey(inviterKey)
  const invite = Invite.createNew(inviter, inviter)
  const publicInvite = finalizeEvent(invite.getEvent(), inviterKey)
  const peerKey = generateSecretKey(), peer = getPublicKey(peerKey)
  const sessionKey = generateSecretKey()
  const shared = Uint8Array.from(invite.sharedSecret.match(/.{2}/g)!, byte => Number.parseInt(byte, 16))
  const initiator = Session.init(invite.inviterEphemeralPublicKey, sessionKey, true, shared)
  const responder = Session.init(getPublicKey(sessionKey), invite.inviterEphemeralPrivateKey!, false, shared)
  responder.receiveEvent(initiator.sendEvent({ pubkey: peer, kind: 14, content: 'hello' }).event)
  const offer = { pubkey: inviter, kind: 21112, content: JSON.stringify({ v: 3, type: 'offer', call_id: 'ab'.repeat(16), video: false, muted: false, codec: 'opus-h264-v3' }) }
  const sealed = responder.sendEvent(offer)
  const wake = callWakeEvent(peer, sealed.event)
  // An observer knows the inviter's identity and invite key from this public record.
  expect(publicInvite.pubkey).toBe(inviter)
  expect(JSON.stringify(publicInvite)).toContain(invite.inviterEphemeralPublicKey)
  for (const senderIdentifier of [inviter, invite.inviterEphemeralPublicKey]) {
    expect(JSON.stringify(wake)).not.toContain(senderIdentifier)
  }
  expect(initiator.receiveEvent(sealed.event)).toMatchObject(offer)
})
it('sends once per target only after the exact ciphertext reaches the durable outbox', async () => {
  const fetch = vi.fn(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetch)
  const publish = vi.fn(async (_event: VerifiedEvent) => {})
  const device = generateSecretKey(), owner = getPublicKey(device), target = getPublicKey(generateSecretKey())
  const queue = vi.fn(async (rumor: Rumor) => rumor)
  await sendCallWakeups(owner, [`02${target}`, `03${target}`], '34'.repeat(16), false, publish, queue, () => true)
  expect(fetch).not.toHaveBeenCalled()
  const rumor = queue.mock.calls[0][0]
  const [sender, receiver] = sessions()
  const { event } = sender.sendEvent(rumor)
  // Without a delivery record nothing says which device to ring.
  await queuedCallWakeEnvelope(event, rumor.id)
  await queuedCallWakeEnvelope(event, rumor.id, getPublicKey(generateSecretKey()))
  expect(publish).not.toHaveBeenCalled()
  await queuedCallWakeEnvelope(event, rumor.id, target)
  await queuedCallWakeEnvelope(event, rumor.id, target)
  expect(publish).toHaveBeenCalledTimes(1)
  expect(publish.mock.calls[0][0].tags).toEqual([['p', target]])
  expect(JSON.stringify(publish.mock.calls[0][0])).not.toContain(owner)
  expect(fetch).not.toHaveBeenCalled()
  expect(receiver.receiveEvent(event)).toMatchObject(rumor)
})
it('references a large authenticated first-call bootstrap only after its exact server ACK', async () => {
  const targetKey = generateSecretKey(), target = getPublicKey(targetKey), sender = generateSecretKey()
  const invite = Invite.createNew(target, target)
  observeCallWakeInvite(finalizeEvent(invite.getEvent(), targetKey))
  const ownerKey = generateSecretKey(), owner = getPublicKey(ownerKey)
  const proof = finalizeEvent(new AppKeys([{ identityPubkey: getPublicKey(sender), createdAt: Math.floor(Date.now() / 1000) }]).getEvent({ ownerPubkey: owner, createdAt: Math.floor(Date.now() / 1000) }), ownerKey)
  const accepted = await invite.accept(getPublicKey(sender), sender, owner, proof)
  await queuedCallWakeEnvelope(accepted.event)
  const publish = vi.fn(async (_event: VerifiedEvent) => {})
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
  await sendCallWakeups(owner, [`02${target}`], '56'.repeat(16), false, publish, async rumor => {
    const { event } = accepted.session.sendEvent(rumor)
    await queuedCallWakeEnvelope(event, rumor.id, target)
    return rumor
  }, () => true)
  expect(publish).not.toHaveBeenCalled()
  await acceptedCallWakeBootstrap(accepted.event)
  const wrapper = JSON.parse(publish.mock.calls[0][0].content)
  for (const identity of [owner, getPublicKey(sender)]) {
    expect(JSON.stringify(accepted.event)).not.toContain(identity)
    expect(JSON.stringify(publish.mock.calls[0][0])).not.toContain(identity)
  }
  expect(accepted.event.tags.filter(tag => tag[0] === 'p')).toEqual([['p', invite.inviterEphemeralPublicKey]])
  expect(wrapper.events.map((event: VerifiedEvent) => event.kind)).toEqual([1060])
  expect(wrapper.bootstrapEventId).toBe(accepted.event.id)
  expect(new TextEncoder().encode(JSON.stringify(publish.mock.calls[0][0])).length).toBeLessThanOrEqual(4096)
})
it('does not send a delayed wake after account change or expiry', async () => {
  const sender = generateSecretKey(), target = getPublicKey(generateSecretKey()), publish = vi.fn(async () => {})
  let active = true
  const queue = vi.fn(async (rumor: Rumor) => rumor)
  await sendCallWakeups(getPublicKey(sender), [`02${target}`], '78'.repeat(16), false, publish, queue, () => active)
  active = false
  const { event } = sessions()[0].sendEvent(queue.mock.calls[0][0])
  await queuedCallWakeEnvelope(event, queue.mock.calls[0][0].id, target)
  expect(publish).not.toHaveBeenCalled()
  active = true
  await sendCallWakeups(getPublicKey(sender), [`02${target}`], '90'.repeat(16), false, publish, queue, () => active)
  await vi.advanceTimersByTimeAsync(40_001)
  const rumor = queue.mock.calls[1][0]
  await queuedCallWakeEnvelope(sessions()[0].sendEvent(rumor).event, rumor.id, target)
  expect(publish).not.toHaveBeenCalled()
})
it('rings each device with its own envelope, read from the session that signed it', async () => {
  const publish = vi.fn(async (_event: VerifiedEvent) => {})
  const owner = getPublicKey(generateSecretKey()), peerOwner = getPublicKey(generateSecretKey())
  const first = getPublicKey(generateSecretKey()), second = getPublicKey(generateSecretKey())
  const [toFirst] = sessions(), [toSecond] = sessions(), [retired] = sessions(), [unknown] = sessions()
  const records = new Map([
    [owner, { devices: new Map() }],
    [peerOwner, { devices: new Map([
      [first, { activeSession: toFirst, inactiveSessions: [] }],
      [second, { activeSession: null, inactiveSessions: [retired, toSecond] }],
    ]) }],
  ])
  const queue = vi.fn(async (rumor: Rumor) => rumor)
  await sendCallWakeups(owner, [`02${first}`, `03${second}`], 'cd'.repeat(16), true, publish, queue, () => true)
  const rumor = queue.mock.calls[0][0]
  const envelopes = [toSecond, toFirst, unknown].map(session => session.sendEvent(rumor).event)
  expect(envelopes.map(envelope => envelopeRecipientDevice(records, envelope))).toEqual([second, first, undefined])
  expect(envelopeRecipientDevice(records, { ...envelopes[0], kind: 1059 })).toBeUndefined()
  // Only an offer that still has devices to ring needs its envelopes looked up.
  expect([awaitsCallWake(rumor.id), awaitsCallWake('f'.repeat(64)), awaitsCallWake()]).toEqual([true, false, false])
  for (const envelope of envelopes) await queuedCallWakeEnvelope(envelope, rumor.id, envelopeRecipientDevice(records, envelope))
  expect(publish).toHaveBeenCalledTimes(2)
  expect(awaitsCallWake(rumor.id)).toBe(false)
  const rung = new Map(publish.mock.calls.map(([wake]: [VerifiedEvent]) => [wake.tags[0][1], JSON.parse(wake.content).events[0].id]))
  expect(rung).toEqual(new Map([[second, envelopes[0].id], [first, envelopes[1].id]]))
  for (const [wake] of publish.mock.calls) {
    expect(wake.tags).toHaveLength(1)
    expect(JSON.parse(wake.content).events[0].tags.map((tag: string[]) => tag[0])).toEqual(['v', 'header'])
    for (const hidden of [owner, peerOwner]) expect(JSON.stringify(wake)).not.toContain(hidden)
  }
})

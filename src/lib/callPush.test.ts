import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type VerifiedEvent } from 'nostr-tools'
import { Session, Invite, AppKeys, type Rumor } from 'nostr-double-ratchet'
import { callWakeEvent, observeCallWakeInvite, queuedCallWakeEnvelope, acceptedCallWakeBootstrap, sendCallWakeups } from './callPush'

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
  const encrypted = sender.sendEvent(clear, [['p', target]])
  const wake = callWakeEvent(device, target, encrypted.event)
  expect(verifyEvent(wake)).toBe(true)
  expect(wake.kind).toBe(21111)
  expect(wake.tags).toEqual([['p', target]])
  expect(wake.content).not.toContain('call_id')
  expect(wake.content).not.toContain('opus-h264')
  const wrapper = JSON.parse(wake.content)
  expect(wrapper).toEqual({ type: 'call-wake', v: 2, events: [JSON.parse(JSON.stringify(encrypted.event))] })
  expect(receiver.receiveEvent(wrapper.events[0])).toMatchObject(clear)
  expect(() => callWakeEvent(device, getPublicKey(generateSecretKey()), encrypted.event)).toThrow('Invalid')
})
it('sends once per target only after the exact ciphertext reaches the durable outbox', async () => {
  const fetch = vi.fn(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetch)
  const publish = vi.fn(async (_event: VerifiedEvent) => {})
  const device = generateSecretKey(), owner = getPublicKey(device), target = getPublicKey(generateSecretKey())
  const queue = vi.fn(async (rumor: Rumor) => rumor)
  await sendCallWakeups(device, owner, [`02${target}`, `03${target}`], '34'.repeat(16), false, 'https://push.example/', publish, queue, () => true)
  expect(fetch).not.toHaveBeenCalled()
  const rumor = queue.mock.calls[0][0]
  const [sender, receiver] = sessions()
  const { event } = sender.sendEvent(rumor, [['p', target]])
  await queuedCallWakeEnvelope(event, rumor.id)
  await queuedCallWakeEnvelope(event, rumor.id)
  expect(publish).toHaveBeenCalledTimes(1)
  expect(fetch).toHaveBeenCalledExactlyOnceWith('https://push.example/events', expect.objectContaining({ body: JSON.stringify(publish.mock.calls[0][0]) }))
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
  await sendCallWakeups(sender, getPublicKey(sender), [`02${target}`], '56'.repeat(16), false, 'https://push.example', publish, async rumor => {
    const { event } = accepted.session.sendEvent(rumor, [['p', target]])
    await queuedCallWakeEnvelope(event, rumor.id)
    return rumor
  }, () => true)
  expect(publish).not.toHaveBeenCalled()
  await acceptedCallWakeBootstrap(accepted.event)
  const wrapper = JSON.parse(publish.mock.calls[0][0].content)
  expect(wrapper.events.map((event: VerifiedEvent) => event.kind)).toEqual([1060])
  expect(wrapper.bootstrapEventId).toBe(accepted.event.id)
  expect(new TextEncoder().encode(JSON.stringify(publish.mock.calls[0][0])).length).toBeLessThanOrEqual(4096)
})
it('does not send a delayed wake after account change or expiry', async () => {
  const sender = generateSecretKey(), target = getPublicKey(generateSecretKey()), publish = vi.fn(async () => {})
  let active = true
  const queue = vi.fn(async (rumor: Rumor) => rumor)
  await sendCallWakeups(sender, getPublicKey(sender), [`02${target}`], '78'.repeat(16), false, 'https://push.example', publish, queue, () => active)
  active = false
  const { event } = sessions()[0].sendEvent(queue.mock.calls[0][0], [['p', target]])
  await queuedCallWakeEnvelope(event, queue.mock.calls[0][0].id)
  expect(publish).not.toHaveBeenCalled()
  active = true
  await sendCallWakeups(sender, getPublicKey(sender), [`02${target}`], '90'.repeat(16), false, 'https://push.example', publish, queue, () => active)
  await vi.advanceTimersByTimeAsync(40_001)
  const rumor = queue.mock.calls[1][0]
  await queuedCallWakeEnvelope(sessions()[0].sendEvent(rumor, [['p', target]]).event, rumor.id)
  expect(publish).not.toHaveBeenCalled()
})

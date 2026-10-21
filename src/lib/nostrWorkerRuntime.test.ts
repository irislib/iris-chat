// @vitest-environment node
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { HashtreeRuntimeEventStore } from '@hashtree/nostr-pubsub'
import { finalizeEvent, generateSecretKey, getPublicKey, nip44, type VerifiedEvent } from 'nostr-tools'
import { AppKeys, Invite, Session } from 'nostr-double-ratchet'
import { TestRelay } from '../../e2e/test-relay'
import { createEventStore } from './eventStore'
import { createNostrWorkerRuntime } from './nostrWorkerRuntime'
import { callWakeEvent, sendCallWakeups, queuedCallWakeEnvelope } from './callPush'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('restarts the real worker queue without replaying identity-bearing call alerts or losing safe pending events', async () => {
  const relay = new TestRelay()
  await relay.start()
  cleanup.push(() => relay.stop())
  const key = generateSecretKey(), recipient = getPublicKey(generateSecretKey())
  const owner = getPublicKey(key)
  const now = Math.floor(Date.now() / 1000)
  const legacy = finalizeEvent({ kind: 21111, created_at: now, tags: [['p', recipient]],
    content: nip44.v2.encrypt(JSON.stringify({ v: 3, type: 'offer', call_id: 'old-call', video: true }),
      nip44.v2.utils.getConversationKey(key, recipient)) }, key)
  const oldMessage = finalizeEvent({ kind: 1060, created_at: now, tags: [['p', recipient]],
    content: 'opaque-existing-session-envelope' }, generateSecretKey())
  const oldBootstrap = finalizeEvent({ kind: 1059, created_at: now, tags: [['p', recipient]],
    content: 'opaque-old-invite-response' }, generateSecretKey())
  // Use a separate invite address so normal replacement does not retire it first.
  const oldInvite = finalizeEvent({ kind: 30078, created_at: now, tags: [['d', 'double-ratchet/invites/old-device']], content: '' }, key)
  const invite = finalizeEvent(Invite.createNew(owner, owner).getEvent(), key)
  const session = Session.init(getPublicKey(generateSecretKey()), generateSecretKey(), true, generateSecretKey())
  const sealed = session.sendEvent({ kind: 14, content: 'new encrypted message' }, [['p', recipient]]).event
  const identityWake = finalizeEvent({ kind: 21111, created_at: now, tags: [['p', recipient]],
    content: JSON.stringify({ type: 'call-wake', v: 2, events: [sealed] }) }, key)
  const wake = callWakeEvent(recipient, sealed)
  const publicPost = finalizeEvent({ kind: 1, created_at: now, tags: [], content: 'public queued post' }, key)
  const beforeRestart = createEventStore(owner)
  const sharedGroup=finalizeEvent({kind:1060,created_at:now,content:'shared group ciphertext',tags:[['v','2'],['header','opaque']]},generateSecretKey())
  const publicGroupRoster=finalizeEvent({kind:37368,created_at:now,content:'',tags:[['type','group_roster'],['member',owner],['member',recipient]]},key)
  for (const event of [legacy, identityWake, oldMessage, oldBootstrap, oldInvite, sharedGroup,publicGroupRoster,invite, wake, publicPost, sealed]) {
    await beforeRestart.putPending({ event, attempts: 1, updatedAt: Date.now(), relays: [relay.url], sources: [] })
  }
  await beforeRestart.close()

  // This is the same factory used by nostrWorker.ts. setRelays automatically
  // starts the shared runtime retry against the persisted production store.
  const runtime = createNostrWorkerRuntime(owner)
  cleanup.push(() => runtime.close())
  runtime.setRelays([relay.url])
  await vi.waitFor(() => {
    const sent = new Set(relay.publishedEvents.map(event => event.id))
    expect(sent).toEqual(new Set([wake.id, publicPost.id, sealed.id, invite.id]))
  }, { timeout: 5000 })
  await vi.waitFor(async () => expect(await runtime.store.listPending()).toEqual([]), { timeout: 5000 })
  // No guessed ciphertext or signed authorization is erased by this gate.
  const retained = await HashtreeRuntimeEventStore.prototype.listPending.call(runtime.store)
  expect(new Set(retained.map(entry => entry.event.id))).toEqual(new Set([legacy.id, identityWake.id, oldMessage.id, oldBootstrap.id, oldInvite.id,sharedGroup.id,publicGroupRoster.id]))

  await expect(runtime.publish(legacy, { relays: [relay.url], requireAck: true, queue: false }))
    .rejects.toThrow('Old call alerts cannot be resent')
  await expect(runtime.publish(identityWake, { relays: [relay.url], requireAck: true, queue: false }))
    .rejects.toThrow('Invalid encrypted call alert')
  for (const event of [oldMessage, oldBootstrap, oldInvite]) {
    await expect(runtime.publish(event, { relays: [relay.url], requireAck: true, queue: false }))
      .rejects.toThrow('Old encrypted messages cannot be resent')
    expect(relay.publishedEvents.some(published => published.id === event.id)).toBe(false)
  }
  expect(relay.publishedEvents.some(event => event.id === legacy.id)).toBe(false)
  expect(relay.publishedEvents.some(event => event.id === identityWake.id)).toBe(false)
  for (const event of [sharedGroup,publicGroupRoster]) {
    await expect(runtime.publish(event,{relays:[relay.url],requireAck:true,queue:false})).rejects.toThrow()
    expect(relay.publishedEvents.some(published=>published.id===event.id)).toBe(false)
  }
})

it('keeps first contact, queued messages and call delivery off identity-authenticated receiver connections', async () => {
  const relay = new TestRelay()
  relay.authRequired = true
  const wire: Array<{ message: unknown[]; connection: number }> = []
  relay.observeWire = (message, connection) => wire.push({ message, connection })
  await relay.start()
  cleanup.push(() => relay.stop())
  const key = generateSecretKey(), owner = getPublicKey(key)
  const peer = getPublicKey(generateSecretKey())
  const peerDevice = getPublicKey(generateSecretKey())
  const ownDevice = getPublicKey(generateSecretKey())
  const otherGroupMember = getPublicKey(generateSecretKey())
  const ownInvite = Invite.createNew(owner, owner)
  const peerInvite = Invite.createNew(peer, peer)
  const ownerProof = finalizeEvent(new AppKeys([{ identityPubkey: owner, createdAt: Math.floor(Date.now() / 1000) }]).getEvent({ ownerPubkey: owner }), key)
  const bootstrap = await peerInvite.accept(owner, key, owner, ownerProof)
  expect(bootstrap.event.tags.some(tag => tag[0] === 'owner-proof')).toBe(true)
  const sealed = bootstrap.session.sendEvent({ kind: 14, content: 'queued before restart' }, [['p', peer]]).event
  const sealFor = (recipient: string, kind: number) => Session.init(getPublicKey(generateSecretKey()),
    generateSecretKey(), true, generateSecretKey()).sendEvent({ kind, content: 'encrypted group or sibling copy' }, [['p', recipient]]).event
  const ownCopy = sealFor(ownDevice, 21113), groupCopy = sealFor(otherGroupMember, 21113)
  let rejectQueued = true
  relay.acceptFilter = event => {
    if (event.id === sealed.id && rejectQueued) { rejectQueued = false; return false }
    return true
  }
  let wake!: VerifiedEvent
  const invite = finalizeEvent(ownInvite.getEvent(), key)
  const pending = createEventStore(owner)
  await pending.putPending({ event: sealed, attempts: 1, updatedAt: Date.now(), relays: [relay.url], sources: [] })
  await pending.close()

  const runtime = createNostrWorkerRuntime(owner, async (_relay, event) => finalizeEvent(event, key))
  cleanup.push(() => runtime.close())
  runtime.setRelays([relay.url])
  const receiver = runtime.subscribe([{ kinds: [1059], '#p': [ownInvite.inviterEphemeralPublicKey] }], { onEvent: () => {} })
  cleanup.push(() => receiver.close())
  const lookups = runtime.subscribe([
    { kinds: [37368], authors: [owner, peer] },
    { kinds: [30078], authors: [peer], '#l': ['double-ratchet/invites'] },
    { kinds: [37368], '#p': [peerDevice] },
    { kinds: [0, 10002, 10050], authors: [owner, peer, otherGroupMember] },
  ], { onEvent: () => {} })
  cleanup.push(() => lookups.close())
  const retried = await runtime.publish(sealed, { relays: [relay.url], queue: true })
  if (!retried.accepted) expect((await runtime.publish(sealed, { relays: [relay.url], queue: true })).accepted).toBe(true)
  await runtime.publish(invite, { relays: [relay.url], requireAck: true, queue: false })
  for (const event of [bootstrap.event, ownCopy, groupCopy]) {
    await runtime.publish(event, { relays: [relay.url], requireAck: true, queue: false })
  }
  const forbiddenHttp = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Identified HTTP publication forbidden'))
  cleanup.push(() => forbiddenHttp.mockRestore())
  await sendCallWakeups(owner, [`02${peer}`], 'ab'.repeat(16), false, async event => {
    wake = event
    return runtime.publish(event, { relays: [relay.url], requireAck: true, queue: false })
  }, async rumor => {
    const envelope = bootstrap.session.sendEvent(rumor, [['p', peer]]).event
    await queuedCallWakeEnvelope(envelope, rumor.id)
    return rumor
  }, () => true)
  expect(forbiddenHttp).not.toHaveBeenCalled()
  await vi.waitFor(() => {
    expect(relay.publishedEvents.map(event => event.id)).toEqual(expect.arrayContaining([
      sealed.id, invite.id, bootstrap.event.id, wake.id, ownCopy.id, groupCopy.id,
    ]))
    expect(wire.some(({ message }) => message[0] === 'AUTH' && (message[1] as { pubkey: string }).pubkey === owner)).toBe(true)
    expect(new Set(wire.filter(({ message }) => message[0] === 'REQ').flatMap(({ message }) =>
      (message.slice(2) as Array<{ authors?: string[]; '#p'?: string[] }>).flatMap(filter => filter.authors ?? filter['#p'] ?? []))))
      .toEqual(new Set([ownInvite.inviterEphemeralPublicKey, owner, peer, peerDevice, otherGroupMember]))
  }, { timeout: 5000 })

  const privateIds = new Set([sealed.id, bootstrap.event.id, wake.id, ownCopy.id, groupCopy.id])
  const cached = await runtime.query([{ ids: [...privateIds] }], { cache: 'cache-only' })
  // Call wakes are ephemeral; retained ciphertext remains available to FIPS.
  expect(new Set(cached.events.map(event => event.id))).toEqual(new Set([...privateIds].filter(id => id !== wake.id)))
  const privateConnections = new Set(wire.filter(({ message }) => message[0] === 'EVENT' &&
    privateIds.has((message[1] as { id: string }).id)).map(({ connection }) => connection))
  expect(privateConnections.size).toBeGreaterThan(0)
  expect(new Set(wire.filter(({ message }) => message[0] === 'EVENT' &&
    (message[1] as { id: string }).id === sealed.id).map(({ connection }) => connection)).size).toBeGreaterThanOrEqual(2)
  const authenticationKeys = new Set<string>()
  for (const connection of privateConnections) {
    const frames = wire.filter(frame => frame.connection === connection).map(frame => frame.message)
    expect(frames.some(frame => frame[0] === 'REQ')).toBe(false)
    const auth = frames.filter(frame => frame[0] === 'AUTH').map(frame => frame[1] as { pubkey: string })
    expect(auth.length).toBeGreaterThan(0)
    expect(auth.every(event => ![owner, peer, ownDevice, otherGroupMember].includes(event.pubkey))).toBe(true)
    for (const key of new Set(auth.map(event => event.pubkey))) {
      expect(authenticationKeys.has(key)).toBe(false)
      authenticationKeys.add(key)
    }
    expect(frames.filter(frame => frame[0] === 'EVENT').every(frame =>
      privateIds.has((frame[1] as { id: string }).id))).toBe(true)
    // Own linked-device delivery cannot identify a neighboring peer/group send.
    expect(new Set(frames.filter(frame => frame[0] === 'EVENT').map(frame =>
      (frame[1] as { id: string }).id)).size).toBe(1)
  }
  const identityConnections = new Set(wire.filter(({ message }) => message[0] === 'AUTH' &&
    (message[1] as { pubkey: string }).pubkey === owner).map(({ connection }) => connection))
  expect([...privateConnections].every(connection => !identityConnections.has(connection))).toBe(true)
  const discoveryFrames = wire.filter(({ message }) => message[0] === 'REQ' &&
    (message.slice(2) as Array<{ kinds?: number[] }>).some(filter => filter.kinds?.some(kind => [0, 10002, 10050, 30078, 37368].includes(kind))))
  for (const connection of new Set(discoveryFrames.map(frame => frame.connection))) {
    const frames = wire.filter(frame => frame.connection === connection).map(frame => frame.message)
    expect(identityConnections.has(connection)).toBe(false)
    expect(privateConnections.has(connection)).toBe(false)
    expect(frames.some(frame => frame[0] === 'EVENT')).toBe(false)
    const auth = frames.filter(frame => frame[0] === 'AUTH').map(frame => frame[1] as { pubkey: string })
    expect(auth.length).toBeGreaterThan(0)
    expect(auth.every(event => ![owner, peer, peerDevice].includes(event.pubkey))).toBe(true)
    const filters = frames.filter(frame => frame[0] === 'REQ').flatMap(frame =>
      frame.slice(2) as Array<{ authors?: string[]; '#p'?: string[] }>)
    expect(new Set(filters.flatMap(filter => filter.authors ?? filter['#p'] ?? [])).size).toBe(1)
    expect(filters.every(filter => !filter['#p']?.includes(ownInvite.inviterEphemeralPublicKey))).toBe(true)
  }
})

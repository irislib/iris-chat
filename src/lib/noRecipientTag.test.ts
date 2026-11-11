// @vitest-environment node
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Filter, type UnsignedEvent, type VerifiedEvent } from 'nostr-tools'
import {
  AppKeys, CHAT_MESSAGE_KIND, InMemoryStorageAdapter, NdrRuntime, buildGroupRosterFactEvent,
  isGroupRosterFactEvent, parseGroupRosterFactRumor, type GroupData, type Rumor,
} from 'nostr-double-ratchet'
import { TestRelay } from '../../e2e/test-relay'
import NostrClient from './nostrClient'
import { createNostrWorkerRuntime } from './nostrWorkerRuntime'
import { createRuntimePublish } from './runtimePublish'
import { createRuntimeSubscribe } from './runtimeSubscribe'
import { CALL_WAKE_KIND, CALL_WAKE_SIGNAL_KIND, envelopeRecipientDevice, queuedCallWakeEnvelope, sendCallWakeups } from './callPush'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

/**
 * One device wired like privateChats.ts: the library runtime hands signed
 * envelopes to the durable outbox, which publishes through the worker runtime
 * and its publication policy to a real relay socket.
 */
class Device {
  readonly storage = new InMemoryStorageAdapter()
  readonly worker
  readonly publication
  readonly rumors: Rumor[] = []
  readonly groupTexts: string[] = []
  readonly groups = new Set<string>()
  readonly failures: unknown[] = []
  readonly runtime: NdrRuntime
  wake?: (event: VerifiedEvent, innerEventId?: string, device?: string) => void

  constructor(readonly owner: string, label: string, private readonly url: string, private readonly ownerKey?: Uint8Array) {
    const worker = this.worker = createNostrWorkerRuntime(`${owner}:${label}`)
    worker.setRelays([url])
    const publication = this.publication = createRuntimePublish({
      storage: this.storage, owner, onlineTarget: new EventTarget(), retryIntervalMs: 1000,
      onError: error => this.failures.push(error),
      publish: async (event, signal, _context, carrier) => {
        signal.throwIfAborted()
        const receipt = await worker.publish(event, { relays: [url], sources: [], requireAck: true, queue: false, localEcho: false,
          ...(carrier && { carrier }) })
        return new Set(receipt.sources.filter(source => source.accepted).map(source => ({ url: source.id })))
      },
    })
    const client = Object.assign(Object.create(NostrClient.prototype), {
      runtime: worker, pool: { connectedRelays: () => [{ url }] },
    }) as NostrClient
    const subscribe = createRuntimeSubscribe(client)
    this.runtime = new NdrRuntime({
      storage: this.storage,
      ...(ownerKey ? { ownerIdentityKey: ownerKey } : {}),
      // Match the production cross-bundle verification boundary.
      nostrSubscribe: (filter, onEvent) => subscribe(filter, event => onEvent(structuredClone(event))),
      nostrFetch: async (filter: Filter) => (await worker.query([filter], { cache: 'network-only', sources: [] }))
        .events.map(event => structuredClone(event) as VerifiedEvent),
      nostrEnqueue: async (event, innerEventId, context) => {
        // The envelope names nobody, so its device is read from the session that signed it.
        const device = envelopeRecipientDevice(this.runtime.getSessionUserRecords(), event)
        await publication.enqueue(event, innerEventId, context)
        this.wake?.(event, innerEventId, device)
      },
      nostrPublish: async (event: UnsignedEvent | VerifiedEvent, innerEventId, context) => {
        const signed = 'sig' in event && event.sig ? event as VerifiedEvent : this.sign(event)
        return publication.publish(signed, innerEventId, context)
      },
      onPublishError: ({ error }) => this.failures.push(error),
      appKeysFetchTimeoutMs: 200, appKeysFastTimeoutMs: 100,
    })
    cleanup.push(async () => { publication.close(); this.runtime.close(); await worker.close() })
  }

  private sign(event: UnsignedEvent): VerifiedEvent {
    if (!this.ownerKey) throw new Error('A linked device signs with its own key')
    return finalizeEvent(event, this.ownerKey)
  }

  get device() { return this.runtime.getState().currentDevicePubkey! }

  async start() {
    this.runtime.onSessionEvent(rumor => { this.rumors.push(rumor) })
    this.runtime.onGroupEvent(async event => {
      if (isGroupRosterFactEvent(event.inner)) {
        const fact = parseGroupRosterFactRumor(event.inner)
        await this.runtime.upsertGroup(fact.group)
        this.groups.add(fact.groupId)
      }
      else if (event.inner.kind === CHAT_MESSAGE_KIND) this.groupTexts.push(event.inner.content)
    })
    await this.runtime.initForOwner(this.owner)
    this.publication.start()
  }

  /** The identity holder authorizes this owner's devices in a public roster. */
  async register(devices: Device[]) {
    const roster = new AppKeys(devices.map(device => ({ identityPubkey: device.device, createdAt: Math.floor(Date.now() / 1000) })))
    const signed = finalizeEvent(roster.getEvent({ ownerPrivateKey: this.ownerKey! }), this.ownerKey!)
    await this.worker.publish(signed, { relays: [this.url], requireAck: true, queue: false })
    for (const device of devices) {
      await device.runtime.refreshOwnAppKeysFromRelay(device.owner, 500)
      await device.runtime.republishInvite()
      expect(device.runtime.getState().registeredDevices).toHaveLength(devices.length)
    }
  }
}

async function person(url: string, deviceCount: number) {
  const key = generateSecretKey(), owner = getPublicKey(key)
  const devices = Array.from({ length: deviceCount }, (_, index) => new Device(owner, `device-${index}`, url, index === 0 ? key : undefined))
  for (const device of devices) await device.start()
  await devices[0]!.register(devices)
  return { owner, key, devices }
}

const text = (device: Device, content: string) => device.rumors.some(rumor => rumor.content === content)

it('publishes direct, first-contact, group and call messages without naming any recipient', async () => {
  const relay = new TestRelay()
  await relay.start(); cleanup.push(() => relay.stop())
  const alice = await person(relay.url, 1), bob = await person(relay.url, 2), carol = await person(relay.url, 1)
  const [a] = alice.devices, [b1, b2] = bob.devices, [c] = carol.devices
  const everyone = [a!, b1!, b2!, c!]

  // First contact: no session exists, so the invite handshake and the message go out together.
  await a!.runtime.sendMessage(bob.owner, 'first contact')
  await vi.waitFor(() => { expect(text(b1!, 'first contact')).toBe(true); expect(text(b2!, 'first contact')).toBe(true) }, { timeout: 15_000 })
  // Direct messages over the established sessions, in both directions.
  await b1!.runtime.sendMessage(alice.owner, 'direct reply')
  await vi.waitFor(() => { expect(text(a!, 'direct reply')).toBe(true); expect(text(b2!, 'direct reply')).toBe(true) }, { timeout: 15_000 })
  await a!.runtime.sendMessage(bob.owner, 'second direct')
  await vi.waitFor(() => expect(text(b2!, 'second direct')).toBe(true), { timeout: 15_000 })

  // Group: the roster travels in private sessions and the message in sender-key ciphertext.
  const group: GroupData = { id: 'tag-free-group', name: 'Friends', members: [alice.owner, bob.owner, carol.owner], admins: [alice.owner], createdAt: Date.now() }
  const roster = finalizeEvent(buildGroupRosterFactEvent(group, { signerPubkey: alice.owner, revision: 1, eventCreatedAt: Math.floor(Date.now() / 1000) }), alice.key)
  await a!.runtime.upsertGroup(group)
  for (const member of [bob.owner, carol.owner]) {
    await a!.runtime.sendEvent(member, { kind: roster.kind, content: roster.content, tags: roster.tags, pubkey: roster.pubkey,
      created_at: roster.created_at, id: roster.id }, undefined, { includeLocalSiblings: false })
  }
  await vi.waitFor(() => { for (const device of [b1!, b2!, c!]) expect(device.groups.has(group.id)).toBe(true) }, { timeout: 15_000 })
  const sent = await a!.runtime.sendGroupMessage(group.id, 'group hello')
  await vi.waitFor(() => { for (const device of [b1!, b2!, c!]) expect(device.groupTexts).toContain('group hello') }, { timeout: 20_000 })

  // Call offer: one wake per ringing device, each around that device's own envelope.
  const wakes: VerifiedEvent[] = []
  a!.wake = (event, innerEventId, device) => {
    void queuedCallWakeEnvelope(event, innerEventId, device).catch(error => a!.failures.push(error))
  }
  await sendCallWakeups(alice.owner, [`02${b1!.device}`, `03${b2!.device}`], 'ab'.repeat(16), false,
    async wake => { wakes.push(wake); await a!.worker.publish(wake, { relays: [relay.url], requireAck: true, queue: false, carrier: 'pairwise' }) },
    rumor => a!.runtime.sendEvent(bob.owner, rumor, alice.owner, { includeLocalSiblings: false }),
    () => true)
  await vi.waitFor(() => expect(relay.publishedEvents.filter(event => event.kind === CALL_WAKE_KIND)).toHaveLength(2), { timeout: 15_000 })
  await vi.waitFor(() => { for (const device of [b1!, b2!]) expect(device.rumors.some(rumor => rumor.kind === CALL_WAKE_SIGNAL_KIND)).toBe(true) }, { timeout: 15_000 })

  const identities = [alice.owner, bob.owner, carol.owner, ...everyone.map(device => device.device)]
  expect(new Set(identities).size).toBe(7)
  const messages = relay.publishedEvents.filter(event => event.kind === 1060)
  // Handshake carriers, both directions, roster and key handoffs, group fanout and the call offer.
  expect(messages.length).toBeGreaterThanOrEqual(12)
  for (const event of messages) {
    expect(event.tags.map(tag => tag[0])).toEqual(['v', 'header'])
    expect(event.tags[0]).toEqual(['v', '2'])
    const wire = JSON.stringify(event)
    for (const hidden of [...identities, group.id, sent.outer.id, sent.outer.pubkey]) expect(wire).not.toContain(hidden)
  }
  // The shared sender-key ciphertext itself never reaches the relay.
  expect(relay.publishedEvents.some(event => event.id === sent.outer.id || event.pubkey === sent.outer.pubkey)).toBe(false)

  expect(wakes.map(wake => wake.tags).sort()).toEqual([[['p', b1!.device]], [['p', b2!.device]]].sort())
  for (const wake of wakes) {
    const inner = JSON.parse(wake.content).events.at(-1) as VerifiedEvent
    expect(verifyEvent(inner)).toBe(true)
    expect(inner.kind).toBe(1060)
    expect(inner.tags.map(tag => tag[0])).toEqual(['v', 'header'])
    for (const hidden of identities) expect(JSON.stringify(inner)).not.toContain(hidden)
    for (const hidden of [alice.owner, a!.device, bob.owner]) expect(JSON.stringify(wake)).not.toContain(hidden)
    // The wake wraps exactly the envelope the relay also carries for that device.
    expect(messages.some(event => event.id === inner.id)).toBe(true)
  }
  expect(new Set(wakes.map(wake => JSON.parse(wake.content).events.at(-1).id)).size).toBe(2)
  for (const device of everyone) expect(device.failures).toEqual([])
}, 90_000)

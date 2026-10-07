// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { TestRelay } from '../../e2e/test-relay'
import { TestRemoteSigner } from '../../e2e/nip46-signer'
import { RemoteSigner, parseBunkerLink } from './remoteSigner'
import { authorizeSignerDevice, fetchSignerRoster } from './signerAuthorization'
import { SilentTestRelay } from '../../e2e/test-relay'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'
import { AppKeys } from 'nostr-double-ratchet'

import { createNostrRuntime } from 'nostr-pubsub'
let runtime: ReturnType<typeof createNostrRuntime>
beforeEach(() => { runtime = createNostrRuntime({ relays: [], historyTimeoutMs: 10_000 }) })

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); await runtime.close() })

async function setup() {
  const relay = new TestRelay()
  await relay.start()
  cleanups.push(() => relay.stop())
  const signer = new TestRemoteSigner(relay.url)
  await signer.start()
  cleanups.push(() => signer.stop())
  const controller = new AbortController()
  cleanups.push(() => controller.abort())
  return { relay, signer, controller }
}

describe('NIP-46 transport', () => {
  it.each([
    ['Device list changed. Try again.', 'Device list changed. Try again.'],
    ['Could not check message servers. Try again.', 'Could not check message servers. Try again.'],
    ['Request not authorized or unsupported.', 'Your other device could not approve this link. Try again.'],
    ['database failed: /private/secret', 'Your other device could not approve this link. Try again.'],
  ])('shows a safe approval failure for %s', async (error: string, message: string) => {
    const { signer, controller } = await setup()
    signer.signingError = error
    const client = new RemoteSigner({ runtime, relays: [], bunkerLink: signer.bunkerLink, signal: controller.signal })
    cleanups.push(() => client.close())
    const owner = await client.connect()
    await expect(client.signEvent({ pubkey: owner, kind: 37368, created_at: Math.floor(Date.now() / 1000), tags: [], content: '' })).rejects.toThrow(message)
  })

  it('rejects malformed signer links and unsafe relay protocols', () => {
    for (const link of ['https://example.org', 'bunker://broken?relay=wss://example.org', `bunker://${'a'.repeat(64)}?relay=https://example.org`, `bunker://${'a'.repeat(64)}?relay=wss://user:password@example.org`]) {
      expect(() => parseBunkerLink(link)).toThrow()
    }
  })

  it('encodes connection-link spaces for Amber without changing literal plus signs', async () => {
    const { relay, controller } = await setup()
    const relayUrl = `${relay.url}/signer+channel`
    let link = ''
    const client = new RemoteSigner({ runtime, relays: [relayUrl], signal: controller.signal, onConnectionLink: value => { link = value; controller.abort() } })
    await expect(client.connect()).rejects.toThrow('cancelled')
    expect(link).toContain('name=Iris%20Chat')
    expect(link).not.toContain('+')
    expect(link).toContain('%2B')
    expect(new URL(link).searchParams.get('relay')).toBe(relayUrl)
  })

  it('uses a live signer relay when another one is unavailable', async () => {
    const { signer, controller } = await setup()
    const link = new URL(signer.bunkerLink)
    link.searchParams.append('relay', 'ws://127.0.0.1:1')
    const client = new RemoteSigner({ runtime, relays: [], bunkerLink: link.toString(), signal: controller.signal })
    cleanups.push(() => client.close())
    expect(await client.connect()).toBe(signer.ownerPubkey)
    expect(signer.ownerPubkey).not.toBe(signer.transportPubkey)
  })

  it('continues after an older signer ignores relay negotiation', async () => {
    const { signer, controller } = await setup()
    signer.ignoreSwitchRelays = true
    const client = new RemoteSigner({ runtime, relays: [], bunkerLink: signer.bunkerLink, signal: controller.signal })
    cleanups.push(() => client.close())
    expect(await client.connect()).toBe(signer.ownerPubkey)
  })

  it('accepts a direct JSON relay array and rejects unsafe switched servers', async () => {
    const { relay, signer, controller } = await setup()
    signer.switchRelaysResult = [relay.url]
    const client = new RemoteSigner({ runtime, relays: [], bunkerLink: signer.bunkerLink, signal: controller.signal })
    cleanups.push(() => client.close())
    expect(await client.connect()).toBe(signer.ownerPubkey)
    client.close()
    signer.switchRelaysResult = ['javascript:alert(1)']
    const bad = new RemoteSigner({ runtime, relays: [], bunkerLink: signer.bunkerLink, signal: controller.signal })
    cleanups.push(() => bad.close())
    await expect(bad.connect()).rejects.toThrow('Invalid signer message server')
  })

  it('only ignores unsupported negotiation methods, retaining explicit denial', async () => {
    const { signer, controller } = await setup()
    signer.switchRelaysError = 'Unsupported method'
    const older = new RemoteSigner({ runtime, relays: [], bunkerLink: signer.bunkerLink, signal: controller.signal })
    cleanups.push(() => older.close())
    expect(await older.connect()).toBe(signer.ownerPubkey)
    older.close()
    signer.switchRelaysError = 'Denied by user'
    const denied = new RemoteSigner({ runtime, relays: [], bunkerLink: signer.bunkerLink, signal: controller.signal })
    cleanups.push(() => denied.close())
    await expect(denied.connect()).rejects.toThrow('declined')
  })

  it('keeps the displayed code usable while waiting for the phone', async () => {
    const { relay, signer, controller } = await setup()
    let link = ''
    const client = new RemoteSigner({ runtime, relays: [relay.url], signal: controller.signal, timeoutMs: 100,
      onConnectionLink: value => { link = value } })
    cleanups.push(() => client.close())
    const connected = client.connect()
    void connected.catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(() => client.ensureActive()).not.toThrow()
    await signer.acceptConnection(link)
    expect(await connected).toBe(signer.ownerPubkey)
  })

  it('ignores late approval after cancellation', async () => {
    const { relay, signer, controller } = await setup()
    let link = ''
    const client = new RemoteSigner({ runtime, relays: [relay.url], signal: controller.signal, onConnectionLink: value => { link = value; controller.abort() } })
    await expect(client.connect()).rejects.toThrow('cancelled')
    await signer.acceptConnection(link)
    expect(signer.requests).toEqual([])
    expect(() => client.ensureActive()).toThrow('cancelled')
  })

  it('does not treat empty discovery as a new account when a server omits EOSE', async () => {
    const { relay, signer, controller } = await setup()
    const silent = new SilentTestRelay()
    await silent.start()
    cleanups.push(() => silent.stop())
    await expect(fetchSignerRoster(signer.ownerPubkey, [relay.url, silent.url], controller.signal, runtime)).rejects.toThrow('Could not check all message servers')
  }, 15_000)

  it('publishes only public authorization when a signer links to an old labeled roster', async () => {
    const { relay, signer, controller } = await setup()
    const oldDevice = getPublicKey(generateSecretKey())
    const previous = new AppKeys([{ identityPubkey: oldDevice, createdAt: 123 }]).getEvent({
      ownerPubkey: signer.ownerPubkey, createdAt: Math.floor(Date.now() / 1000) - 1,
    })
    previous.tags.push(['encrypted_device_labels', 'old-private-names'])
    await runtime.publish(finalizeEvent(previous, signer.ownerSecret), {
      relays: [relay.url], sources: [], requireAck: true, queue: false, localEcho: false,
    })
    const authorized = await authorizeSignerDevice({ runtime,
      owner: signer.ownerPubkey, relays: [relay.url], signal: controller.signal,
      signEvent: async event => finalizeEvent(event, signer.ownerSecret),
    })
    const published = relay.publishedEvents.find(event => event.id === authorized.event.id)
    expect(published).toMatchObject({ id: authorized.event.id, sig: authorized.event.sig,
      pubkey: authorized.event.pubkey, tags: authorized.event.tags, content: authorized.event.content })
    expect(authorized.event.tags.some(tag => tag[0] === 'encrypted_device_labels' ||
      (tag[0] === 'f' && tag[1] === 'encrypted_device_labels'))).toBe(false)
    expect(AppKeys.fromEvent(authorized.event).getAllDevices()).toEqual(expect.arrayContaining([
      { identityPubkey: oldDevice, createdAt: 123 },
      expect.objectContaining({ identityPubkey: getPublicKey(authorized.deviceSecret) }),
    ]))
  })

  it('never queues a rejected authorization after discarding its device key', async () => {
    const { relay, signer, controller } = await setup()
    relay.acceptFilter = event => event.kind !== 37368
    await expect(authorizeSignerDevice({ runtime,
      owner: signer.ownerPubkey, relays: [relay.url], signal: controller.signal,
      signEvent: async event => finalizeEvent(event, signer.ownerSecret),
    })).rejects.toThrow()
    expect(await runtime.store.listPending()).toEqual([])
    expect(relay.publishedEvents.some(event => event.kind === 37368)).toBe(false)
  })

  it('retains the approved device key once publication starts despite cancellation', async () => {
    const { relay, signer, controller } = await setup()
    const authorized = await authorizeSignerDevice({ runtime,
      owner: signer.ownerPubkey,
      relays: [relay.url],
      signal: controller.signal,
      signEvent: async event => finalizeEvent(event, signer.ownerSecret),
      onCommitting: () => controller.abort(),
    })
    expect(relay.publishedEvents.some(event => event.id === authorized.event.id)).toBe(true)
    expect(authorized.event.tags.some(tag => tag[0] === 'device' && tag[1] === getPublicKey(authorized.deviceSecret))).toBe(true)
  })
})

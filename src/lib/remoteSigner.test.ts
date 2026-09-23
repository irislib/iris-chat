// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { TestRelay } from '../../e2e/test-relay'
import { TestRemoteSigner } from '../../e2e/nip46-signer'
import { RemoteSigner, parseBunkerLink } from './remoteSigner'
import { authorizeSignerDevice, fetchSignerRoster } from './signerAuthorization'
import { SilentTestRelay } from '../../e2e/test-relay'
import { finalizeEvent, getPublicKey } from 'nostr-tools'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

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
  it('rejects malformed signer links and unsafe relay protocols', () => {
    for (const link of ['https://example.org', 'bunker://broken?relay=wss://example.org', `bunker://${'a'.repeat(64)}?relay=https://example.org`, `bunker://${'a'.repeat(64)}?relay=wss://user:password@example.org`]) {
      expect(() => parseBunkerLink(link)).toThrow()
    }
  })

  it('encodes connection-link spaces for Amber without changing literal plus signs', async () => {
    const { relay, controller } = await setup()
    const relayUrl = `${relay.url}/signer+channel`
    let link = ''
    const client = new RemoteSigner({ relays: [relayUrl], signal: controller.signal, onConnectionLink: value => { link = value; controller.abort() } })
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
    const client = new RemoteSigner({ relays: [], bunkerLink: link.toString(), signal: controller.signal })
    cleanups.push(() => client.close())
    expect(await client.connect()).toBe(signer.ownerPubkey)
    expect(signer.ownerPubkey).not.toBe(signer.transportPubkey)
  })

  it('continues after an older signer ignores relay negotiation', async () => {
    const { signer, controller } = await setup()
    signer.ignoreSwitchRelays = true
    const client = new RemoteSigner({ relays: [], bunkerLink: signer.bunkerLink, signal: controller.signal })
    cleanups.push(() => client.close())
    expect(await client.connect()).toBe(signer.ownerPubkey)
  })

  it('accepts a direct JSON relay array and rejects unsafe switched servers', async () => {
    const { relay, signer, controller } = await setup()
    signer.switchRelaysResult = [relay.url]
    const client = new RemoteSigner({ relays: [], bunkerLink: signer.bunkerLink, signal: controller.signal })
    cleanups.push(() => client.close())
    expect(await client.connect()).toBe(signer.ownerPubkey)
    client.close()
    signer.switchRelaysResult = ['javascript:alert(1)']
    const bad = new RemoteSigner({ relays: [], bunkerLink: signer.bunkerLink, signal: controller.signal })
    cleanups.push(() => bad.close())
    await expect(bad.connect()).rejects.toThrow('Invalid signer message server')
  })

  it('only ignores unsupported negotiation methods, retaining explicit denial', async () => {
    const { signer, controller } = await setup()
    signer.switchRelaysError = 'Unsupported method'
    const older = new RemoteSigner({ relays: [], bunkerLink: signer.bunkerLink, signal: controller.signal })
    cleanups.push(() => older.close())
    expect(await older.connect()).toBe(signer.ownerPubkey)
    older.close()
    signer.switchRelaysError = 'Denied by user'
    const denied = new RemoteSigner({ relays: [], bunkerLink: signer.bunkerLink, signal: controller.signal })
    cleanups.push(() => denied.close())
    await expect(denied.connect()).rejects.toThrow('declined')
  })

  it('expires and removes a pending connection', async () => {
    const { relay, controller } = await setup()
    const client = new RemoteSigner({ relays: [relay.url], signal: controller.signal, timeoutMs: 50 })
    await expect(client.connect()).rejects.toThrow('timed out')
    expect(() => client.ensureActive()).toThrow('timed out')
  })

  it('ignores late approval after cancellation', async () => {
    const { relay, signer, controller } = await setup()
    let link = ''
    const client = new RemoteSigner({ relays: [relay.url], signal: controller.signal, onConnectionLink: value => { link = value; controller.abort() } })
    await expect(client.connect()).rejects.toThrow('cancelled')
    await signer.acceptConnection(link)
    expect(signer.requests).toEqual([])
    expect(() => client.ensureActive()).toThrow('cancelled')
  })

  it('fails a device-list lookup when any server omits EOSE', async () => {
    const { relay, signer, controller } = await setup()
    const silent = new SilentTestRelay()
    await silent.start()
    cleanups.push(() => silent.stop())
    await expect(fetchSignerRoster(signer.ownerPubkey, [relay.url, silent.url], controller.signal)).rejects.toThrow('Could not check all message servers')
  }, 15_000)

  it('retains the approved device key once publication starts despite cancellation', async () => {
    const { relay, signer, controller } = await setup()
    const authorized = await authorizeSignerDevice({
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

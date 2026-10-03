// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { AppKeys } from 'nostr-double-ratchet'
import { createNostrRuntime } from 'nostr-pubsub'
import { finalizeEvent, generateSecretKey, getPublicKey, type VerifiedEvent } from 'nostr-tools'
import { TestRelay } from '../../e2e/test-relay'
import { RemoteSigner } from './remoteSigner'
import { authorizeSignerDevice, prepareSignerAuthorization } from './signerAuthorization'
import { parseDeviceConnectLink, serveDeviceLink, validateDeviceAddition } from './deviceLinkSigner'

const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function roster() {
  const secret = generateSecretKey(), owner = getPublicKey(secret), approver = getPublicKey(generateSecretKey())
  const keys = new AppKeys(); keys.addDevice({ identityPubkey: approver, createdAt: Math.floor(Date.now() / 1000) - 5 })
  const event = finalizeEvent(keys.getEvent({ ownerPubkey: owner, createdAt: Math.floor(Date.now() / 1000) - 4 }), secret)
  return { secret, owner, approver, event }
}
describe('private device-link approval', () => {
  it('only signs the exact fresh roster plus one new device', () => {
    const { owner, event } = roster(), device = getPublicKey(generateSecretKey())
    const draft = prepareSignerAuthorization(owner, device, event)
    expect(validateDeviceAddition(draft, owner, event).device).toBe(device)
    for (const change of [
      (value: typeof draft) => { value.kind = 1 },
      (value: typeof draft) => { value.content = 'arbitrary signing' },
      (value: typeof draft) => { value.tags = value.tags.filter(tag => tag[1] !== event.tags.find(tag => tag[0] === 'device')?.[1]) },
      (value: typeof draft) => { value.tags.find(tag => tag[0] === 'device')![2] = '1' },
      (value: typeof draft) => { value.tags.push(['revoked', 'a'.repeat(64)]) },
      (value: typeof draft) => { value.tags.push(['device', getPublicKey(generateSecretKey()), String(Math.floor(Date.now() / 1000))]) },
    ]) {
      const altered = structuredClone(draft); change(altered)
      expect(() => validateDeviceAddition(altered, owner, event)).toThrow()
    }
    expect(() => parseDeviceConnectLink(`nostrconnect://${device}?relay=wss://example.org&secret=test&perms=sign_event:1`)).toThrow('unsupported')
  })

  it('exchanges encrypted requests and private pair metadata before publishing exact authorization', async () => {
    const relay = new TestRelay(); await relay.start(); cleanup.push(() => relay.stop())
    const runtime = createNostrRuntime({ relays: [relay.url] }); cleanup.push(() => runtime.close())
    const { secret, owner, approver, event } = roster()
    await runtime.publish(event, { requireAck: true })
    const controller = new AbortController(); cleanup.push(() => controller.abort())
    let approval: Promise<void> | undefined
    const pairs: Array<{ device: string; linkAt: number; linkId: string }> = []
    const client = new RemoteSigner({ runtime, relays: [relay.url], signal: controller.signal,
      onConnectionLink: link => { approval = serveDeviceLink({ link, owner, approver, runtime, signal: controller.signal,
        sign: async draft => finalizeEvent(draft, secret), savePair: async (device, linkAt, linkId) => { pairs.push({ device, linkAt, linkId }) } }) },
    }); cleanup.push(() => client.close())
    expect(await client.connect()).toBe(owner)
    let checked = false
    const result = await authorizeSignerDevice({ runtime, relays: [relay.url], signal: controller.signal, owner,
      signEvent: draft => client.signEvent(draft), onAuthorized: (signed, device) => {
        checked = true
        const entry = AppKeys.fromEvent(signed).getAllDevices().find(item => item.identityPubkey === device)!
        expect(client.linkInfo).toEqual({ v: 1, approver, device, linkId: client.transportPubkey, linkAt: entry.createdAt })
        expect(pairs).toEqual([{ device, linkId: client.transportPubkey, linkAt: entry.createdAt }])
        expect(relay.publishedEvents.filter(item => item.kind === 37368)).toHaveLength(1)
      } })
    await approval
    expect(checked).toBe(true)
    expect(AppKeys.fromEvent(result.event as VerifiedEvent).getAllDevices()).toHaveLength(2)
    expect(relay.publishedEvents.every(item => item.kind === 37368 || item.kind === 24133)).toBe(true)
    expect(JSON.stringify(relay.publishedEvents)).not.toContain('iris_get_link_info')
    expect(JSON.stringify(relay.publishedEvents)).not.toContain('historyPolicy')
  })
})

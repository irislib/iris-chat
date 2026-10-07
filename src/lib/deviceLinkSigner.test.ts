// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppKeys } from 'nostr-double-ratchet'
import { createNostrRuntime } from 'nostr-pubsub'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate, type VerifiedEvent } from 'nostr-tools'
import { TestRelay } from '../../e2e/test-relay'
import { RemoteSigner, type SignerRuntime } from './remoteSigner'
import { authorizeSignerDevice, prepareSignerAuthorization, selectSignerRoster } from './signerAuthorization'
import { parseDeviceConnectLink, prepareDeviceLinkRoster, serveDeviceLink, validateDeviceAddition } from './deviceLinkSigner'

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

  it.each([[false, false], [true, false], [true, true]])('exchanges encrypted approval with duplicate heads=%s and unavailable server=%s', async (duplicate: boolean, outage: boolean) => {
    const relay = new TestRelay(); await relay.start(); cleanup.push(() => relay.stop())
    const runtime = createNostrRuntime({ relays: [relay.url] }); cleanup.push(() => runtime.close())
    const { secret, owner, approver, event } = roster()
    const relays = outage ? [relay.url, 'ws://127.0.0.1:1'] : [relay.url]
    await runtime.publish(event, { requireAck: true })
    const initialHeads = [event]
    if (duplicate) {
      const extra = finalizeEvent(AppKeys.fromEvent(event).getEvent({ ownerPubkey: owner, createdAt: event.created_at }), secret)
      initialHeads.push(extra)
      expect(() => selectSignerRoster([event, extra], owner)).toThrow('Conflicting')
      await runtime.publish(extra, { requireAck: true })
    }
    const controller = new AbortController(); cleanup.push(() => controller.abort())
    let approval: Promise<void> | undefined
    const pairs: Array<{ device: string; linkAt: number; linkId: string }> = []
    const client = new RemoteSigner({ runtime, relays, signal: controller.signal,
      onConnectionLink: link => { approval = serveDeviceLink({ link, owner, approver, runtime, signal: controller.signal,
        getKnownRoster: () => ({ devices: AppKeys.fromEvent(event).getAllDevices(), createdAt: event.created_at }),
        sign: async draft => finalizeEvent(draft, secret), savePair: async (device, linkAt, linkId) => { pairs.push({ device, linkAt, linkId }) } }); approval.catch(() => {}) },
    }); cleanup.push(() => client.close())
    expect(await client.connect()).toBe(owner)
    if (duplicate) {
      const repaired = selectSignerRoster(relay.publishedEvents, owner)!
      expect(repaired.created_at).toBeGreaterThan(event.created_at)
      expect(repaired.tags).toEqual(initialHeads.sort((a, b) => a.id.localeCompare(b.id))[0].tags)
      expect(AppKeys.fromEvent(repaired).getAllDevices()).toEqual(AppKeys.fromEvent(event).getAllDevices())
    }
    let checked = false
    const result = await authorizeSignerDevice({ runtime, relays, signal: controller.signal, owner,
      signEvent: draft => client.signEvent(draft), onAuthorized: (signed, device) => {
        checked = true
        const entry = AppKeys.fromEvent(signed).getAllDevices().find(item => item.identityPubkey === device)!
        expect(client.linkInfo).toEqual({ v: 1, approver, device, linkId: client.transportPubkey, linkAt: entry.createdAt })
        expect(pairs).toEqual([{ device, linkId: client.transportPubkey, linkAt: entry.createdAt }])
        expect(relay.publishedEvents.filter(item => item.kind === 37368)).toHaveLength(duplicate ? 3 : 1)
      } })
    await approval
    expect(checked).toBe(true)
    expect(AppKeys.fromEvent(result.event as VerifiedEvent).getAllDevices()).toHaveLength(2)
    expect(relay.publishedEvents.every(item => item.kind === 37368 || item.kind === 24133)).toBe(true)
    expect(JSON.stringify(relay.publishedEvents)).not.toContain('iris_get_link_info')
    expect(JSON.stringify(relay.publishedEvents)).not.toContain('historyPolicy')
  }, 100_000)

  it.each(['membership', 'join time', 'extra tag', 'unknown tag', 'tag order', 'malformed UUID', 'duplicate d', 'duplicate i', 'wrong i', 'local changed', 'local changed during signing', 'newer local', 'heads changed', 'signer changed', 'no ack', 'readback conflict', 'cancelled'])('does not repair %s', async (change: string) => {
    const { secret, owner, approver, event } = roster()
    const extra = finalizeEvent(AppKeys.fromEvent(event).getEvent({ ownerPubkey: owner, createdAt: event.created_at }), secret)
    let tags = extra.tags.map(tag => [...tag])
    if (change === 'membership') tags = tags.map(tag => tag[0] === 'device' ? ['device', getPublicKey(generateSecretKey()), tag[2]] : tag)
    if (change === 'join time') tags = tags.map(tag => tag[0] === 'device' ? ['device', tag[1], String(Number(tag[2]) + 1)] : tag)
    if (change === 'extra tag') tags.push(['revoked', 'a'.repeat(64)])
    if (change === 'unknown tag') tags.push(['future-field', 'opaque'])
    if (change === 'tag order') tags.reverse()
    if (change === 'malformed UUID') tags = tags.map(tag => ['d', 'i'].includes(tag[0]) ? [tag[0], 'not-a-uuid', ...tag.slice(2)] : tag)
    if (change === 'duplicate d') tags.push([...tags.find(tag => tag[0] === 'd')!])
    if (change === 'duplicate i') tags.push([...tags.find(tag => tag[0] === 'i')!])
    if (change === 'wrong i') tags = tags.map(tag => tag[0] === 'i' ? ['i', crypto.randomUUID(), 'subject'] : tag)
    let heads: Event[] = [event, finalizeEvent({ ...extra, tags }, secret)]
    let queries = 0
    let signed = false
    const controller = new AbortController()
    const publish = vi.fn(async (signed: Event) => {
      heads = change === 'readback conflict' ? [signed, finalizeEvent({ ...signed, tags: [...signed.tags, ['unexpected', 'field']] }, secret)] : [signed]
      return { remoteAccepted: change !== 'no ack' }
    })
    const runtime = { publish, query: async () => ({ complete: true, events: ++queries === 2 && change === 'heads changed' ? [event] : heads }) } as unknown as SignerRuntime
    await expect(prepareDeviceLinkRoster({ owner, approver, relays: ['wss://example.org'], signal: controller.signal, runtime,
      getKnownRoster: () => ({ devices: change === 'local changed' || (change === 'local changed during signing' && signed) ? [] : AppKeys.fromEvent(event).getAllDevices(), createdAt: event.created_at + (change === 'newer local' ? 1 : 0) }),
      sign: async draft => { signed = true; if (change === 'cancelled') controller.abort(); return finalizeEvent(change === 'signer changed' ? { ...draft, content: 'changed' } : draft, secret) },
    })).rejects.toThrow()
    expect(publish).toHaveBeenCalledTimes(['no ack', 'readback conflict'].includes(change) ? 1 : 0)
  })

  it.each([false, true])('rejects an older remote roster when local state advances during signing=%s', async (duringSigning: boolean) => {
    const relay = new TestRelay(); await relay.start(); cleanup.push(() => relay.stop())
    const runtime = createNostrRuntime({ relays: [relay.url] }); cleanup.push(() => runtime.close())
    const { secret, owner, approver, event } = roster()
    await runtime.publish(event, { requireAck: true })
    let knownAt = event.created_at + (duringSigning ? 0 : 1)
    const savePair = vi.fn()
    const controller = new AbortController(); cleanup.push(() => controller.abort())
    let approval!: Promise<void>
    const client = new RemoteSigner({ runtime, relays: [relay.url], signal: controller.signal,
      onConnectionLink: link => {
        approval = serveDeviceLink({ link, owner, approver, runtime, signal: controller.signal,
          getKnownRoster: () => ({ devices: AppKeys.fromEvent(event).getAllDevices(), createdAt: knownAt }),
          sign: async draft => { knownAt++; return finalizeEvent(draft, secret) }, savePair })
        approval.catch(() => {})
      },
    }); cleanup.push(() => client.close())
    expect(await client.connect()).toBe(owner)
    await expect(authorizeSignerDevice({ runtime, relays: [relay.url], signal: controller.signal, owner,
      signEvent: draft => client.signEvent(draft) })).rejects.toThrow('Device list changed. Try again.')
    await expect(approval).rejects.toThrow('device list changed')
    expect(savePair).not.toHaveBeenCalled()
    expect(relay.publishedEvents.filter(item => item.kind === 37368)).toHaveLength(1)
  })

  it('bounds approval preparation and cannot publish after a delayed signature returns', async () => {
    const { secret, owner, approver, event } = roster()
    const extra = finalizeEvent(AppKeys.fromEvent(event).getEvent({ ownerPubkey: owner, createdAt: event.created_at }), secret)
    const publish = vi.fn(), close = vi.fn()
    const runtime = { publish, query: async () => ({ complete: true, events: [event, extra] }), subscribe: () => ({ close }) } as unknown as SignerRuntime
    let finishSigning!: () => void
    const approval = serveDeviceLink({ owner, approver, runtime, signal: new AbortController().signal, timeoutMs: 100,
      link: `nostrconnect://${getPublicKey(generateSecretKey())}?relay=wss://example.org&secret=test`,
      getKnownRoster: () => ({ devices: AppKeys.fromEvent(event).getAllDevices(), createdAt: event.created_at }),
      sign: draft => new Promise(resolve => { finishSigning = () => resolve(finalizeEvent(draft, secret)) }),
      savePair: async () => { throw new Error('Unexpected pair') },
    })
    await expect(approval).rejects.toThrow('expired')
    expect(close).toHaveBeenCalledOnce()
    finishSigning()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(publish).not.toHaveBeenCalled()
  })

  it.each(['encrypted_device_labels', 'f'])('never republishes retired private labels from matching %s heads', async (form: string) => {
    const { secret, owner, approver, event } = roster()
    const legacy = form === 'f' ? ['f', 'encrypted_device_labels', 'old-ciphertext'] : ['encrypted_device_labels', 'old-ciphertext']
    const heads = [event, finalizeEvent(AppKeys.fromEvent(event).getEvent({ ownerPubkey: owner, createdAt: event.created_at }), secret)]
      .map(head => finalizeEvent({ ...head, tags: [...head.tags, legacy] }, secret))
    const publish = vi.fn(), sign = vi.fn(async (draft: EventTemplate) => finalizeEvent(draft, secret))
    const runtime = { publish, query: async () => ({ complete: true, events: heads }) } as unknown as SignerRuntime
    await expect(prepareDeviceLinkRoster({ owner, approver, runtime, signal: new AbortController().signal, relays: ['wss://example.org'], sign,
      getKnownRoster: () => ({ devices: AppKeys.fromEvent(event).getAllDevices(), createdAt: event.created_at }),
    })).rejects.toThrow()
    expect(sign).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppKeys, InMemoryStorageAdapter, NdrRuntime } from 'nostr-double-ratchet'
import { finalizeEvent, generateSecretKey, getPublicKey, type VerifiedEvent } from 'nostr-tools'
import { restoreSignerAuthorization } from './signerAuthorizationStorage'

const stored = vi.hoisted(() => ({ proof: undefined as unknown }))
vi.mock('./storage', () => ({ getSessionManagerValue: async () => stored.proof }))
const runtimes: NdrRuntime[] = []
afterEach(() => { runtimes.splice(0).forEach(runtime => runtime.close()); stored.proof = undefined })

describe('signed device authorization bootstrap', () => {
  it('does not merge a cached proof into conflicting same-time authorization', async () => {
    const ownerSecret = generateSecretKey()
    const owner = getPublicKey(ownerSecret)
    const deviceSecret = generateSecretKey()
    const device = getPublicKey(deviceSecret)
    const storage = new InMemoryStorageAdapter()
    await storage.put('v1/device-manager/identity-public-key', device)
    await storage.put('v1/device-manager/identity-private-key', Array.from(deviceSecret))
    stored.proof = finalizeEvent(new AppKeys([{ identityPubkey: device, createdAt: 100 }]).getEvent({ ownerPubkey: owner, createdAt: 120 }), ownerSecret)
    const runtime = new NdrRuntime({ storage, nostrSubscribe: () => () => {}, nostrPublish: async event => ('sig' in event ? event : finalizeEvent(event, deviceSecret)) as VerifiedEvent })
    runtimes.push(runtime)
    await runtime.initForOwner(owner)
    await runtime.applyTrustedAppKeysSnapshot({ ownerPubkey: owner, appKeys: new AppKeys(), createdAt: 120 })
    await expect(restoreSignerAuthorization(runtime, owner)).rejects.toThrow('Conflicting')
    expect(runtime.getState().isCurrentDeviceRegistered).toBe(false)
  })

  it('restores authorization and history cutoff without an identity secret and honors newer revocations', async () => {
    const ownerSecret = generateSecretKey()
    const owner = getPublicKey(ownerSecret)
    const deviceSecret = generateSecretKey()
    const device = getPublicKey(deviceSecret)
    const storage = new InMemoryStorageAdapter()
    await storage.put('v1/device-manager/identity-public-key', device)
    await storage.put('v1/device-manager/identity-private-key', Array.from(deviceSecret))
    const proof = finalizeEvent(new AppKeys([{ identityPubkey: device, createdAt: 100 }]).getEvent({ ownerPubkey: owner, createdAt: 120 }), ownerSecret)
    stored.proof = proof
    const runtime = new NdrRuntime({
      storage,
      nostrSubscribe: () => () => {},
      nostrPublish: async event => ('sig' in event ? event : finalizeEvent(event, deviceSecret)) as VerifiedEvent,
    })
    runtimes.push(runtime)
    await runtime.initForOwner(owner)
    await restoreSignerAuthorization(runtime, owner)
    expect(runtime.getState().isCurrentDeviceRegistered).toBe(true)
    expect(runtime.getState().lastAppKeysCreatedAt).toBe(120)
    expect(runtime.getState().currentDevicePubkey).toBe(device)

    await runtime.applyTrustedAppKeysSnapshot({ ownerPubkey: owner, appKeys: new AppKeys(), createdAt: 121 })
    await restoreSignerAuthorization(runtime, owner)
    expect(runtime.getState().isCurrentDeviceRegistered).toBe(false)
    expect(runtime.getState().lastAppKeysCreatedAt).toBe(121)
  })
})

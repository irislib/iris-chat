import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  owner: 'a'.repeat(64), device: 'b'.repeat(64), linked: false,
  waitFor: vi.fn(), register: vi.fn(), refresh: vi.fn(), invite: vi.fn(),
  state: {} as Record<string, unknown>,
}))
vi.mock('nostr-double-ratchet', async (original) => {
  const actual = await original<typeof import('nostr-double-ratchet')>()
  return { ...actual,
    AppKeys: class extends actual.AppKeys { static waitFor = mocks.waitFor },
    NdrRuntime: class {
      getState() { return mocks.state }
      initForOwner = vi.fn().mockResolvedValue(undefined)
      prepareRegistration = vi.fn(async () => ({ newDeviceIdentity: mocks.device }))
      publishPreparedRegistration = mocks.register
      refreshOwnAppKeysFromRelay = mocks.refresh
      republishInvite = mocks.invite
      onStateChange() { return () => {} }
      close() {}
    },
  }
})
vi.mock('./identity', async () => {
  const { writable } = await import('svelte/store')
  return { ndk: writable({ pool: { connectedRelays: () => [{}] } }),
    identity: writable({ pubkey: mocks.owner }), getPrivkeyHex: () => '1'.repeat(64),
    getPrivkeyBytes: () => new Uint8Array(32).fill(1), isLinkedDeviceLogin: () => mocks.linked }
})
vi.mock('./devices', () => ({ devices: { reset: vi.fn() } }))
vi.mock('./relayStore', () => ({ relayStore: { getState: () => ({ relays: [] }) } }))
vi.mock('./sessionManagerStorage', () => ({ DexieStorageAdapter: class {} }))
vi.mock('./deviceLabels', () => ({ getCurrentDeviceRegistrationLabels: async () => ({}), getLinkedDeviceRegistrationLabels: async () => ({}) }))
vi.mock('./runtimeSubscribe', () => ({ createRuntimeSubscribe: vi.fn() }))
vi.mock('./runtimePublish', () => ({ createRuntimePublish: () => ({ start() {}, close() {}, enqueue: vi.fn(), publish: vi.fn() }) }))
vi.mock('./messageRelayStatus', () => ({ notifyMessageRelayPublish: vi.fn() }))
vi.mock('./nostrPubsubRuntime', () => ({ publishNostrPubsub: vi.fn() }))
vi.mock('./storage', () => ({ deleteSessionManagerValue: vi.fn(), putSessionManagerValue: vi.fn() }))

import { initMultiDevice, resetManagers, waitForSendReadyRuntime } from './privateChats'

const roster = (devices: string[]) => ({ getAllDevices: () => devices.map(identityPubkey => ({ identityPubkey, createdAt: 1 })) })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.linked = false
  mocks.state = { ownerPubkey: mocks.owner, currentDevicePubkey: mocks.device,
    registeredDevices: [{ identityPubkey: mocks.device, createdAt: 1 }], isCurrentDeviceRegistered: true }
  mocks.register.mockResolvedValue(undefined)
  mocks.refresh.mockResolvedValue(undefined)
  mocks.invite.mockResolvedValue(undefined)
})
afterEach(() => resetManagers())

describe('restored device registration on startup', () => {
  it('republishes a cached registration missing from current server records without sending a message', async () => {
    mocks.waitFor.mockResolvedValueOnce(null).mockResolvedValueOnce(roster([mocks.device]))
    await initMultiDevice(mocks.owner)
    expect(mocks.register).toHaveBeenCalledOnce()
    expect(mocks.waitFor).toHaveBeenCalledTimes(2)
    expect(mocks.invite).toHaveBeenCalledOnce()
  })

  it('leaves an existing current registration alone', async () => {
    mocks.waitFor.mockResolvedValue(roster([mocks.device]))
    await initMultiDevice(mocks.owner)
    expect(mocks.waitFor).toHaveBeenCalledOnce()
    expect(mocks.register).not.toHaveBeenCalled()
  })

  it('does not re-register a device omitted from a current server roster', async () => {
    mocks.waitFor.mockResolvedValue(roster([]))
    await initMultiDevice(mocks.owner)
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(mocks.register).not.toHaveBeenCalled()
  })

  it('does not register a previously unregistered device or a linked device', async () => {
    mocks.state.registeredDevices = []
    mocks.state.isCurrentDeviceRegistered = false
    await initMultiDevice(mocks.owner)
    expect(mocks.waitFor).not.toHaveBeenCalled()
    resetManagers()
    mocks.linked = true
    mocks.state.isCurrentDeviceRegistered = true
    await initMultiDevice(mocks.owner)
    expect(mocks.register).not.toHaveBeenCalled()
  })
})

it('can send after signing device approval while server confirmation is still pending', async () => {
  mocks.state.registeredDevices = []
  mocks.state.isCurrentDeviceRegistered = false
  mocks.waitFor.mockReturnValue(new Promise(() => {}))
  await Promise.race([
    waitForSendReadyRuntime(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Send waited for server confirmation')), 100)),
  ])
  expect(mocks.register).toHaveBeenCalledOnce()
})


it('keeps sending blocked when preparing the signed approval fails', async () => {
  mocks.state.registeredDevices = []
  mocks.state.isCurrentDeviceRegistered = false
  mocks.register.mockRejectedValueOnce(new Error('Signing approval failed'))
  await expect(waitForSendReadyRuntime()).rejects.toThrow('Signing approval failed')
  expect(mocks.waitFor).not.toHaveBeenCalled()
})

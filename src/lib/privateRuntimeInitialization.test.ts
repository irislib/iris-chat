import { afterEach, expect, it } from 'vitest'
import { AppKeys, InMemoryStorageAdapter, NdrRuntime } from 'nostr-double-ratchet'
import { finalizeEvent, generateSecretKey, getPublicKey, type VerifiedEvent } from 'nostr-tools'
import { get } from 'svelte/store'
import { devices, onCurrentDeviceRemovedFromRoster } from './devices'
import { initializeAuthorizedRuntime } from './privateRuntimeInitialization'

const runtimes: NdrRuntime[] = []
const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).forEach(stop => stop())
  runtimes.splice(0).forEach(runtime => runtime.close())
  devices.reset()
})

it.each([false, true])('restores the roster version before replay on restart; newer revocation=%s', async (revoked: boolean) => {
  const secret = generateSecretKey(), owner = getPublicKey(secret)
  const deviceSecret = generateSecretKey(), device = getPublicKey(deviceSecret)
  const storage = new InMemoryStorageAdapter()
  await storage.put('v1/device-manager/identity-public-key', device)
  await storage.put('v1/device-manager/identity-private-key', Array.from(deviceSecret))
  const roster = (included: boolean, createdAt: number) => finalizeEvent(new AppKeys(included
    ? [{ identityPubkey: device, createdAt: 100 }] : []).getEvent({ ownerPubkey: owner, createdAt }), secret)
  const grant = roster(true, 120), historical = roster(false, 100), removal = roster(false, 121)
  const makeRuntime = (event?: VerifiedEvent) => {
    const runtime = new NdrRuntime({ storage,
      nostrPublish: async unsigned => ('sig' in unsigned ? unsigned : finalizeEvent(unsigned, deviceSecret)) as VerifiedEvent,
      nostrSubscribe: (filter, callback) => {
        if (event && filter.kinds?.includes(37368)) callback(event)
        return () => {}
      },
    })
    runtimes.push(runtime)
    return runtime
  }
  const first = makeRuntime()
  await first.initForOwner(owner)
  await first.applyVerifiedAppKeysEvent(grant)
  first.close()

  const reloaded = makeRuntime(revoked ? removal : historical)
  const removals: string[] = []
  cleanups.push(onCurrentDeviceRemovedFromRoster(pubkey => removals.push(pubkey)))
  cleanups.push(reloaded.onStateChange(state => {
    if (state.currentDevicePubkey) devices.setIdentityPubkey(state.currentDevicePubkey)
    devices.setRegisteredDevices(state.registeredDevices, state.lastAppKeysCreatedAt)
  }))
  await initializeAuthorizedRuntime(reloaded, owner, async () => {
    await reloaded.applyVerifiedAppKeysEvent(grant)
  })
  // Drive the same asynchronous verified-roster path after startup as well.
  await reloaded.applyVerifiedAppKeysEvent(revoked ? removal : historical)
  expect(removals).toEqual(revoked ? [device] : [])
  expect(get(devices).isCurrentDeviceRegistered).toBe(!revoked)
  expect(reloaded.getState().lastAppKeysCreatedAt).toBe(revoked ? 121 : 120)
})

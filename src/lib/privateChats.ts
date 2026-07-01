import { get } from 'svelte/store'
import {
  NDKEvent,
  NDKRelaySet,
  NDKSubscriptionCacheUsage,
  type NDKFilter,
} from '@nostr-dev-kit/ndk'
import {
  AppKeys,
  Invite,
  INVITE_RESPONSE_KIND,
  NdrRuntime,
  buildAppKeysDeviceAuthorizationFilter,
  createDeviceLinkRequest,
  decryptInviteResponse,
  deterministicLinkInviteForDeviceLinkRequest,
  parseCompactDeviceLinkRequest,
  resolveAppKeysOwnerForDevice,
  type AppKeysManager,
  type CreatedDeviceLinkRequest,
  type DelegateManager,
  type DeviceEntry,
  type NdrRuntimeState,
  type NostrFetch,
  type NostrPublish,
  type NostrSubscribe,
} from 'nostr-double-ratchet'
import {
  ndk,
  identity,
  getPrivkeyHex,
  getPrivkeyBytes,
  isLinkedDeviceLogin,
} from './identity'
import { devices } from './devices'
import { relayStore } from './relayStore'
import { DexieStorageAdapter } from './sessionManagerStorage'
import type { VerifiedEvent } from 'nostr-tools'
import {
  getCurrentDeviceRegistrationLabels,
  getLinkedDeviceRegistrationLabels,
} from './deviceLabels'
import { createRuntimeSubscribe } from './runtimeSubscribe'
import { asNdkEventSubscription } from './ndkSubscription'
import { notifyMessageRelayPublish } from './messageRelayStatus'
import { deleteSessionManagerValue, putSessionManagerValue } from './storage'

let runtime: NdrRuntime | null = null
let runtimeCleanup: (() => void) | null = null
let previousRuntimeState: NdrRuntimeState | null = null
let rotateInvitePromise: Promise<void> | null = null
let linkedInviteRepublishTimer: ReturnType<typeof setTimeout> | null = null
let runtimeOwnerIdentityKeyHex: string | null = null
const verifiedDeviceRegistrations = new Set<string>()
let activeDeviceRegistration:
  | { ownerPubkey: string; promise: Promise<void> }
  | null = null

const APP_KEYS_FETCH_TIMEOUT_MS = 8000
const APP_KEYS_FAST_TIMEOUT_MS = 2000
const LINKED_INVITE_REPUBLISH_RETRY_MS = 1500
const DEVICE_LINK_TIMEOUT_MS = 120_000
const DEVICE_MANAGER_STORAGE_PREFIX = 'v1/device-manager'

export type DeviceLinkSession = {
  url: string
  stop: () => void
}

const persistCompactLinkRuntimeDelegate = async (
  localRequest: CreatedDeviceLinkRequest
): Promise<void> => {
  const invite = deterministicLinkInviteForDeviceLinkRequest(localRequest.request)
  await Promise.all([
    putSessionManagerValue(
      `${DEVICE_MANAGER_STORAGE_PREFIX}/identity-public-key`,
      localRequest.request.deviceAppKeyPubkey
    ),
    putSessionManagerValue(
      `${DEVICE_MANAGER_STORAGE_PREFIX}/identity-private-key`,
      Array.from(localRequest.deviceAppKeySecretKey)
    ),
    putSessionManagerValue(`${DEVICE_MANAGER_STORAGE_PREFIX}/invite`, invite.serialize()),
    deleteSessionManagerValue(`${DEVICE_MANAGER_STORAGE_PREFIX}/owner-pubkey`),
  ])
}

const registrationKey = (ownerPubkey: string, devicePubkey: string): string =>
  `${ownerPubkey}:${devicePubkey}`

const now = (): number => Math.round(Date.now() / 1000)

const stateIncludesDevice = (
  state: NdrRuntimeState,
  devicePubkey: string | null | undefined
): devicePubkey is string => {
  const normalizedDevice = devicePubkey?.trim().toLowerCase()
  if (!normalizedDevice) return false
  return state.registeredDevices.some(
    (device) => device.identityPubkey.trim().toLowerCase() === normalizedDevice
  )
}

const isVerifiedCurrentDevice = (ownerPubkey: string, state: NdrRuntimeState): boolean => {
  const devicePubkey = state.currentDevicePubkey
  return !!(
    devicePubkey &&
    stateIncludesDevice(state, devicePubkey) &&
    verifiedDeviceRegistrations.has(registrationKey(ownerPubkey, devicePubkey))
  )
}

const verifyCurrentDeviceOnRelay = async (
  currentRuntime: NdrRuntime,
  ownerPubkey: string,
  timeoutMs: number = APP_KEYS_FETCH_TIMEOUT_MS
): Promise<void> => {
  const devicePubkey = currentRuntime.getState().currentDevicePubkey
  if (!devicePubkey) {
    throw new Error('Current device pubkey not available')
  }

  const relayAppKeys = await AppKeys.waitFor(
    ownerPubkey,
    createRelayOnlySubscribe(getNDK()),
    timeoutMs
  )
  const relayIncludesDevice =
    relayAppKeys
      ?.getAllDevices()
      .some(
        (device) =>
          device.identityPubkey.trim().toLowerCase() ===
          devicePubkey.trim().toLowerCase()
      ) ?? false

  if (!relayIncludesDevice) {
    throw new Error(
      `Relay AppKeys for ${ownerPubkey} do not include current device ${devicePubkey}`
    )
  }

  await currentRuntime
    .refreshOwnAppKeysFromRelay(ownerPubkey, APP_KEYS_FAST_TIMEOUT_MS)
    .catch(() => {})
  verifiedDeviceRegistrations.add(registrationKey(ownerPubkey, devicePubkey))
}

const registerCurrentDeviceAndVerify = async (
  currentRuntime: NdrRuntime,
  ownerPubkey: string,
  labels?: Awaited<ReturnType<typeof getCurrentDeviceRegistrationLabels>>
): Promise<void> => {
  if (activeDeviceRegistration?.ownerPubkey === ownerPubkey) {
    return activeDeviceRegistration.promise
  }

  const promise = (async () => {
    await currentRuntime.registerCurrentDevice({
      ownerPubkey,
      timeoutMs: APP_KEYS_FETCH_TIMEOUT_MS,
      ...labels,
    })
    await verifyCurrentDeviceOnRelay(currentRuntime, ownerPubkey)
  })()

  activeDeviceRegistration = { ownerPubkey, promise }
  try {
    await promise
  } finally {
    if (activeDeviceRegistration?.promise === promise) {
      activeDeviceRegistration = null
    }
  }
}

const createSubscribe = (
  ndkInstance: ReturnType<typeof getNDK>,
  cacheUsage: NDKSubscriptionCacheUsage = NDKSubscriptionCacheUsage.PARALLEL
): NostrSubscribe => {
  return createRuntimeSubscribe(ndkInstance, cacheUsage)
}

const createRelayOnlySubscribe = (
  ndkInstance: ReturnType<typeof getNDK>
): NostrSubscribe => {
  return (filter, onEvent) => {
    const relayUrls = [...relayStore.getState().relays]
    const relayOptions = relayUrls.length > 0 ? { relayUrls } : {}
    const subscription = asNdkEventSubscription(
      ndkInstance.subscribe(filter as NDKFilter, {
        closeOnEose: false,
        cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
        skipOptimisticPublishEvent: true,
        ...relayOptions,
      })
    )
    subscription.on('event', (event) => {
      onEvent(event.rawEvent() as Parameters<typeof onEvent>[0])
    })
    subscription.start()
    return () => subscription.stop()
  }
}

export const publishRuntimeEventFireAndForget = <T>(
  event: T,
  publish: () => Promise<RuntimePublishResult>,
  onAcceptedRelays?: (relayUrls: string[]) => void
): T => {
  void publish()
    .then((publishedRelays) => {
      if (publishedRelays.size === 0) {
        console.warn('[privateChats] Runtime event was not accepted by any relay')
        return
      }
      const relayUrls = getPublishedRelayUrls(publishedRelays)
      if (relayUrls.length > 0) {
        onAcceptedRelays?.(relayUrls)
      }
    })
    .catch((error) => {
      console.warn('[privateChats] Runtime event publish failed:', error)
    })
  return event
}

export type RuntimePublishResult = {
  size: number
  [Symbol.iterator]?: () => IterableIterator<unknown>
}

function relayUrlFromPublishedRelay(relay: unknown): string | null {
  if (!relay || typeof relay !== 'object') return null

  const directUrl = (relay as { url?: unknown }).url
  if (typeof directUrl === 'string' && directUrl.trim()) {
    return directUrl.trim()
  }

  const nestedUrl = (relay as { relay?: { url?: unknown } }).relay?.url
  if (typeof nestedUrl === 'string' && nestedUrl.trim()) {
    return nestedUrl.trim()
  }

  return null
}

export function getPublishedRelayUrls(publishedRelays: RuntimePublishResult): string[] {
  const iterator = publishedRelays[Symbol.iterator]?.()
  if (!iterator) return []

  const urls: string[] = []
  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    const url = relayUrlFromPublishedRelay(next.value)
    if (url) urls.push(url)
  }
  return Array.from(new Set(urls)).sort()
}

const createPublish = (ndkInstance: ReturnType<typeof getNDK>): NostrPublish => {
  return (async (event, innerEventId) => {
    return publishRuntimeEventFireAndForget(event, async () => {
      const e = new NDKEvent(ndkInstance, event)
      const relayUrls = [...relayStore.getState().relays]
      const relaySet = NDKRelaySet.fromRelayUrls(relayUrls, ndkInstance, true)
      return e.publish(relaySet, 10000, 1)
    }, (relayUrls) => {
      notifyMessageRelayPublish(innerEventId, relayUrls)
    }) as never
  }) as NostrPublish
}

const createFetch = (
  ndkInstance: ReturnType<typeof getNDK>,
): NostrFetch => {
  return (async (filter: Parameters<NostrFetch>[0]) => {
    const events = await ndkInstance.fetchEvents(filter, {
      cacheUsage: NDKSubscriptionCacheUsage.PARALLEL,
    })
    return Array.from(events)
      .map((event) => event.rawEvent() as VerifiedEvent | undefined)
      .filter((event): event is VerifiedEvent => !!event)
  }) as unknown as NostrFetch
}

function getNDK() {
  return get(ndk)
}

const syncDevicesFromRuntime = (state: NdrRuntimeState): void => {
  if (state.currentDevicePubkey) {
    devices.setIdentityPubkey(state.currentDevicePubkey)
  }
  devices.setAppKeysManagerReady(state.appKeysManagerReady)
  devices.setSessionManagerReady(state.sessionManagerReady)
  devices.setHasLocalAppKeys(state.hasLocalAppKeys)
  devices.setRegisteredDevices(state.registeredDevices, state.lastAppKeysCreatedAt)
}

const republishInviteWithRetry = async (reason: string): Promise<void> => {
  await republishInvite()

  if (linkedInviteRepublishTimer) {
    clearTimeout(linkedInviteRepublishTimer)
  }
  linkedInviteRepublishTimer = setTimeout(() => {
    linkedInviteRepublishTimer = null
    void republishInvite().catch((e) => {
      console.warn(`[privateChats] Deferred invite republish failed (${reason}):`, e)
    })
  }, LINKED_INVITE_REPUBLISH_RETRY_MS)
}

const getRuntime = (): NdrRuntime => {
  const ownerIdentityKeyHex = getPrivkeyHex()

  if (runtime && runtimeOwnerIdentityKeyHex === ownerIdentityKeyHex) {
    return runtime
  }

  runtimeCleanup?.()
  runtimeCleanup = null
  runtime?.close()
  runtime = null
  previousRuntimeState = null
  runtimeOwnerIdentityKeyHex = ownerIdentityKeyHex
  verifiedDeviceRegistrations.clear()
  activeDeviceRegistration = null

  const ndkInstance = getNDK()
  const ownerIdentityKey = getPrivkeyBytes()
  runtime = new NdrRuntime({
    nostrSubscribe: createSubscribe(ndkInstance),
    nostrPublish: createPublish(ndkInstance),
    nostrFetch: createFetch(ndkInstance),
    storage: new DexieStorageAdapter(),
    appKeysFetchTimeoutMs: APP_KEYS_FETCH_TIMEOUT_MS,
    appKeysFastTimeoutMs: APP_KEYS_FAST_TIMEOUT_MS,
    ...(ownerIdentityKey ? { ownerIdentityKey } : {}),
  })
  runtimeOwnerIdentityKeyHex = ownerIdentityKeyHex

  runtimeCleanup = runtime.onStateChange((state) => {
    const previousState = previousRuntimeState
    syncDevicesFromRuntime(state)

    if (
      isLinkedDeviceLogin() &&
      previousState &&
      !previousState.isCurrentDeviceRegistered &&
      state.isCurrentDeviceRegistered
    ) {
      void republishInviteWithRetry('linked device registration').catch((err) => {
        console.warn('[privateChats] Republish invite after linked registration failed:', err)
      })
    }

    previousRuntimeState = state
  })
  return runtime
}

export const getNdrRuntime = (): NdrRuntime => {
  return getRuntime()
}

const ensureConnected = async (): Promise<void> => {
  const ndkInstance = getNDK()
  if (ndkInstance.pool.connectedRelays().length === 0) {
    await ndkInstance.pool.connect(5000)
  }
}

export const initAppKeysManager = async (): Promise<void> => {
  await getRuntime().initAppKeysManager()
}

export const initDelegateManager = async (): Promise<void> => {
  await getRuntime().initDelegateManager()
}

export const initNdrRuntime = async (ownerPubkey: string): Promise<void> => {
  await getRuntime().initForOwner(ownerPubkey)
}

export const waitForNdrRuntime = async (): Promise<NdrRuntime> => {
  const currentRuntime = getRuntime()
  if (currentRuntime.getState().sessionManagerReady) {
    return currentRuntime
  }

  const ownerPubkey = currentRuntime.getState().ownerPubkey || get(identity)?.pubkey
  if (!ownerPubkey) {
    throw new Error('NdrRuntime owner not initialized')
  }
  await currentRuntime.initForOwner(ownerPubkey)
  return currentRuntime
}

export const waitForSendReadyRuntime = async (): Promise<NdrRuntime> => {
  await ensureDeviceRegistered()
  return waitForNdrRuntime()
}

export const preparePeerNdrRuntime = async (
  recipientPubkey: string
): Promise<NdrRuntime> => {
  const currentRuntime = await waitForSendReadyRuntime()
  await currentRuntime.setupUser(recipientPubkey).catch((e) => {
    console.warn(
      '[privateChats] Failed to prepare peer runtime user setup:',
      recipientPubkey,
      e
    )
  })
  return currentRuntime
}

export const getDelegateManager = (): DelegateManager => {
  const manager = getRuntime().getDelegateManager()
  if (!manager) throw new Error('DelegateManager not initialized')
  return manager
}

export const getAppKeysManager = (): AppKeysManager => {
  const manager = getRuntime().getAppKeysManager()
  if (!manager) throw new Error('AppKeysManager not initialized')
  return manager
}

export const initMultiDevice = async (ownerPubkey: string): Promise<void> => {
  await ensureConnected()

  const currentRuntime = getRuntime()
  await currentRuntime.initForOwner(ownerPubkey)

  let linkedDeviceAuthorized = currentRuntime.getState().isCurrentDeviceRegistered
  if (isLinkedDeviceLogin() && !linkedDeviceAuthorized) {
    try {
      await currentRuntime.refreshOwnAppKeysFromRelay(
        ownerPubkey,
        APP_KEYS_FETCH_TIMEOUT_MS
      )
      linkedDeviceAuthorized = currentRuntime.getState().isCurrentDeviceRegistered
    } catch (e) {
      console.warn('[privateChats] Linked-device AppKeys backfill failed:', e)
    }
    if (!linkedDeviceAuthorized) {
      console.warn(
        '[privateChats] Linked device is waiting for owner AppKeys authorization.'
      )
    }
  }

  try {
    if (!isLinkedDeviceLogin() || linkedDeviceAuthorized) {
      if (isLinkedDeviceLogin()) {
        await republishInviteWithRetry('linked device init')
      } else {
        await republishInvite()
      }
    }
  } catch (e) {
    console.warn('[privateChats] Republish invite failed:', e)
  }
}

export const hasLocalAppKeys = (): boolean => {
  return getRuntime().getState().hasLocalAppKeys
}

export const registerDevice = async (): Promise<void> => {
  if (isLinkedDeviceLogin()) {
    throw new Error('Linked devices cannot register other devices')
  }

  const ownerPubkey = get(identity)?.pubkey
  if (!ownerPubkey) {
    throw new Error('Owner pubkey not available')
  }

  const labels = await getCurrentDeviceRegistrationLabels()

  await ensureConnected()
  const currentRuntime = getRuntime()
  await currentRuntime.initForOwner(ownerPubkey)
  await registerCurrentDeviceAndVerify(currentRuntime, ownerPubkey, labels)
}

export const registerLinkedDevice = async (identityPubkey: string): Promise<void> => {
  if (isLinkedDeviceLogin()) {
    throw new Error('Linked devices cannot register other devices')
  }

  const ownerPubkey = get(identity)?.pubkey
  if (!ownerPubkey) {
    throw new Error('Owner pubkey not available')
  }

  const labels = await getLinkedDeviceRegistrationLabels()

  await ensureConnected()
  await getRuntime().initForOwner(ownerPubkey)
  await getRuntime().registerDeviceIdentity({
    ownerPubkey,
    identityPubkey,
    timeoutMs: APP_KEYS_FETCH_TIMEOUT_MS,
    ...labels,
  })
}

export const startDeviceLink = async (
  onAccepted: (ownerPubkey: string) => void | Promise<void>
): Promise<DeviceLinkSession> => {
  await ensureConnected()

  const localRequest = createDeviceLinkRequest({
    requestedAt: now(),
  })
  await persistCompactLinkRuntimeDelegate(localRequest)
  const subscribe = createRelayOnlySubscribe(getNDK())
  let stopped = false
  let completed = false
  let timeout: ReturnType<typeof setTimeout>

  const unsubscribe = subscribe(
    buildAppKeysDeviceAuthorizationFilter(localRequest.request.deviceAppKeyPubkey) as NDKFilter,
    async (event) => {
      if (stopped || completed) return

      let ownerPubkey: string | null = null
      try {
        ownerPubkey = resolveAppKeysOwnerForDevice(
          event as unknown as Parameters<typeof resolveAppKeysOwnerForDevice>[0],
          localRequest.request.deviceAppKeyPubkey
        )
      } catch {
        return
      }
      if (!ownerPubkey) return

      completed = true
      clearTimeout(timeout)
      unsubscribe()
      await onAccepted(ownerPubkey)
    }
  )

  timeout = setTimeout(() => {
    stopped = true
    unsubscribe()
  }, DEVICE_LINK_TIMEOUT_MS)

  return {
    url: localRequest.code,
    stop: () => {
      stopped = true
      clearTimeout(timeout)
      unsubscribe()
    },
  }
}

export const createLinkInvite = async (): Promise<Invite> => {
  await initDelegateManager()
  return getRuntime().createLinkInvite(get(identity)?.pubkey)
}

export const buildLinkInviteUrl = (
  invite: Invite,
  root: string,
  ownerPubkey?: string
): string => {
  const data: Record<string, string> = {
    inviter: invite.inviter,
    ephemeralKey: invite.inviterEphemeralPublicKey,
    sharedSecret: invite.sharedSecret,
    purpose: 'link',
  }
  if (ownerPubkey) {
    data.owner = ownerPubkey
  }
  const url = new URL(root)
  url.hash = `/invite/${encodeURIComponent(JSON.stringify(data))}`
  return url.toString()
}

export const listenForLinkInviteAcceptance = (
  invite: Invite,
  onAccepted: (ownerPubkey: string) => void
): (() => void) => {
  const delegateManager = getDelegateManager()
  if (!invite.inviterEphemeralPrivateKey) {
    throw new Error('Invite missing ephemeral private key')
  }

  const inviterPrivateKey = delegateManager.getIdentityKey()
  const subscribe = createSubscribe(getNDK())

  return subscribe(
    {
      kinds: [INVITE_RESPONSE_KIND],
      '#p': [invite.inviterEphemeralPublicKey],
    } as NDKFilter,
    async (event) => {
      try {
        if (invite.maxUses && invite.usedBy.length >= invite.maxUses) {
          return
        }

        const decrypted = await decryptInviteResponse({
          envelopeContent: event.content,
          envelopeSenderPubkey: event.pubkey,
          inviterEphemeralPrivateKey: invite.inviterEphemeralPrivateKey!,
          inviterPrivateKey,
          sharedSecret: invite.sharedSecret,
        })

        invite.usedBy.push(decrypted.inviteeIdentity)
        onAccepted(decrypted.ownerPublicKey || decrypted.inviteeIdentity)
      } catch {
        // Ignore invalid responses.
      }
    }
  )
}

export const ensureDeviceRegistered = async (): Promise<void> => {
  if (isLinkedDeviceLogin()) {
    return
  }

  const ownerPubkey =
    getRuntime().getState().ownerPubkey || get(identity)?.pubkey
  if (!ownerPubkey) {
    throw new Error('Owner pubkey not available')
  }

  await ensureConnected()
  const currentRuntime = getRuntime()
  await currentRuntime.initForOwner(ownerPubkey)

  let state = currentRuntime.getState()
  if (!isVerifiedCurrentDevice(ownerPubkey, state)) {
    if (stateIncludesDevice(state, state.currentDevicePubkey)) {
      try {
        await verifyCurrentDeviceOnRelay(
          currentRuntime,
          ownerPubkey,
          APP_KEYS_FAST_TIMEOUT_MS
        )
        state = currentRuntime.getState()
      } catch {
        verifiedDeviceRegistrations.delete(
          registrationKey(ownerPubkey, state.currentDevicePubkey!)
        )
      }
    }
  }

  if (!isVerifiedCurrentDevice(ownerPubkey, state)) {
    const labels = await getCurrentDeviceRegistrationLabels()
    await registerCurrentDeviceAndVerify(currentRuntime, ownerPubkey, labels)
  }
  void republishInvite().catch((e) => {
    console.warn('[privateChats] Invite republish after registration failed:', e)
  })
}

export const revokeDevice = async (identityPubkey: string): Promise<void> => {
  await revokeDevices([identityPubkey])
}

export const revokeDevices = async (identityPubkeys: string[]): Promise<void> => {
  if (isLinkedDeviceLogin()) {
    throw new Error('Linked devices cannot revoke devices')
  }

  const ownerPubkey =
    getRuntime().getState().ownerPubkey || get(identity)?.pubkey
  if (!ownerPubkey) {
    throw new Error('Owner pubkey not available')
  }

  const uniquePubkeys = Array.from(
    new Set(identityPubkeys.map((pubkey) => pubkey.trim()).filter(Boolean))
  )
  if (uniquePubkeys.length === 0) return

  await ensureConnected()
  const currentRuntime = getRuntime()
  await currentRuntime.initForOwner(ownerPubkey)

  const currentDevicePubkey = currentRuntime.getState().currentDevicePubkey
  const revocablePubkeys = uniquePubkeys.filter(
    (pubkey) => pubkey !== currentDevicePubkey
  )
  if (revocablePubkeys.length === 0) return

  const relayAppKeys = await currentRuntime.resolveBaseAppKeys(
    ownerPubkey,
    APP_KEYS_FAST_TIMEOUT_MS
  )
  const localAppKeys = currentRuntime.getAppKeysManager()?.getAppKeys()
  const baseAppKeys =
    localAppKeys &&
    localAppKeys.getAllDevices().length > relayAppKeys.getAllDevices().length
      ? localAppKeys
      : relayAppKeys
  const nextAppKeys = new AppKeys(
    baseAppKeys.getAllDevices(),
    baseAppKeys.getAllDeviceLabels()
  )
  const originalDevices = nextAppKeys.getAllDevices()
  const originalDevicePubkeys = new Set(originalDevices.map((device) => device.identityPubkey))

  for (const identityPubkey of revocablePubkeys) {
    nextAppKeys.removeDevice(identityPubkey)
  }

  const nextDevices = nextAppKeys.getAllDevices()
  if (
    nextDevices.length === originalDevices.length ||
    revocablePubkeys.every((pubkey) => !originalDevicePubkeys.has(pubkey))
  ) {
    return
  }

  await currentRuntime.publishPreparedRevocation({
    ownerPubkey,
    appKeys: nextAppKeys,
    devices: nextDevices,
    revokedIdentity: revocablePubkeys[0],
  })
}

export const startAppKeysSubscription = (ownerPubkey: string): void => {
  getRuntime().startAppKeysSubscription(ownerPubkey)
}

export const stopAppKeysSubscription = (): void => {
  runtime?.stopAppKeysSubscription()
}

export const resetManagers = (): void => {
  if (linkedInviteRepublishTimer) {
    clearTimeout(linkedInviteRepublishTimer)
    linkedInviteRepublishTimer = null
  }
  runtimeCleanup?.()
  runtimeCleanup = null
  runtime?.close()
  runtime = null
  previousRuntimeState = null
  rotateInvitePromise = null
  runtimeOwnerIdentityKeyHex = null
  devices.reset()
  verifiedDeviceRegistrations.clear()
  activeDeviceRegistration = null
}

export const republishInvite = async (): Promise<void> => {
  await ensureConnected()
  await getRuntime().republishInvite()
}

export const rotateDeviceInvite = async (): Promise<void> => {
  if (rotateInvitePromise) return rotateInvitePromise

  rotateInvitePromise = (async () => {
    await ensureConnected()
    await getRuntime().rotateInvite()
  })().finally(() => {
    rotateInvitePromise = null
  })

  return rotateInvitePromise
}

export const getRegisteredDevices = (): DeviceEntry[] => {
  return getRuntime().getState().registeredDevices
}

export const acceptDeviceLink = async (input: string): Promise<void> => {
  if (isLinkedDeviceLogin()) {
    throw new Error('Linked devices cannot add devices')
  }

  const parsed = parseCompactDeviceLinkRequest(input)
  if (!parsed) {
    throw new Error('Invalid link code')
  }

  const currentIdentity = get(identity)
  if (!currentIdentity?.pubkey) {
    throw new Error('Owner pubkey not available')
  }

  const ndrInvite = deterministicLinkInviteForDeviceLinkRequest(parsed)

  await ensureConnected()
  const currentRuntime = getRuntime()
  await currentRuntime.initForOwner(currentIdentity.pubkey)
  const labels = await getLinkedDeviceRegistrationLabels()
  const preparedRegistration = await currentRuntime.prepareRegistrationForIdentity({
    ownerPubkey: currentIdentity.pubkey,
    identityPubkey: parsed.deviceAppKeyPubkey,
    timeoutMs: 0,
    ...labels,
  })
  await currentRuntime.publishPreparedRegistration(preparedRegistration)
  await currentRuntime.acceptLinkInvite(ndrInvite, currentIdentity.pubkey)
}

export const acceptLinkInvite = async (invite: Invite): Promise<void> => {
  if (isLinkedDeviceLogin()) {
    throw new Error('Linked devices cannot accept link invites')
  }

  const currentIdentity = get(identity)
  if (!currentIdentity?.pubkey) {
    throw new Error('Owner pubkey not available')
  }
  if (invite.ownerPubkey && invite.ownerPubkey !== currentIdentity.pubkey) {
    throw new Error('Link invite is for a different account')
  }

  await ensureConnected()
  const currentRuntime = getRuntime()
  await currentRuntime.initForOwner(currentIdentity.pubkey)
  await currentRuntime.acceptLinkInvite(invite, currentIdentity.pubkey)
}

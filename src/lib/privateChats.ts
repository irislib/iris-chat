import { get } from 'svelte/store'
import {
  NDKEvent,
  NDKRelaySet,
  NDKSubscriptionCacheUsage,
  type NDKFilter,
} from '@nostr-dev-kit/ndk'
import {
  AppKeys,
  APP_KEYS_EVENT_KIND,
  Invite,
  INVITE_RESPONSE_KIND,
  NdrRuntime,
  decryptInviteResponse,
  isAppKeysEvent,
  type AppKeysManager,
  type DelegateManager,
  type DeviceEntry,
  type NdrRuntimeState,
  type NostrFetch,
  type NostrPublish,
  type NostrSubscribe,
} from 'nostr-double-ratchet'
import {
  bytesToHex,
  ndk,
  identity,
  getPrivkeyHex,
  getPrivkeyBytes,
  isLinkedDeviceLogin,
} from './identity'
import { devices } from './devices'
import { relayStore } from './relayStore'
import { DexieStorageAdapter } from './sessionManagerStorage'
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type UnsignedEvent,
  type VerifiedEvent,
} from 'nostr-tools'
import * as nip44 from 'nostr-tools/nip44'
import {
  getCurrentDeviceRegistrationLabels,
  getLinkedDeviceRegistrationLabels,
} from './deviceLabels'
import { createRuntimeSubscribe } from './runtimeSubscribe'
import { asNdkEventSubscription } from './ndkSubscription'
import { notifyMessageRelayPublish } from './messageRelayStatus'

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
const NIP46_KIND = 24133
const NIP46_LINK_TIMEOUT_MS = 120_000

type Nip46RequestMethod = 'connect' | 'get_public_key' | 'sign_event' | 'ping'

type Nip46RequestMessage = {
  id: string
  method: Nip46RequestMethod
  params: string[]
}

type Nip46ResponseMessage = {
  id: string
  result?: string
  error?: string
}

type Nip46Message = Nip46RequestMessage | Nip46ResponseMessage

export type Nip46LinkDeviceRequest = {
  clientPubkey: string
  secret: string
  relays: string[]
  devicePubkey: string
}

export type Nip46LinkDeviceSession = {
  url: string
  stop: () => void
}

const registrationKey = (ownerPubkey: string, devicePubkey: string): string =>
  `${ownerPubkey}:${devicePubkey}`

const now = (): number => Math.round(Date.now() / 1000)

const nip46RequestId = (): string =>
  String(crypto.getRandomValues(new Uint32Array(1))[0])

const isNip46RequestMessage = (message: Nip46Message): message is Nip46RequestMessage =>
  'method' in message && typeof message.method === 'string'

const encodeNip46Message = (message: Nip46Message): string => JSON.stringify(message)

const decodeNip46Message = (plaintext: string): Nip46Message | null => {
  try {
    const message = JSON.parse(plaintext) as Record<string, unknown>
    if (!message || typeof message !== 'object' || typeof message.id !== 'string') {
      return null
    }
    if ('method' in message) {
      if (typeof message.method !== 'string' || !Array.isArray(message.params)) {
        return null
      }
      return {
        id: message.id,
        method: message.method as Nip46RequestMethod,
        params: message.params.filter((param): param is string => typeof param === 'string'),
      }
    }
    return {
      id: message.id,
      ...(typeof message.result === 'string' ? { result: message.result } : {}),
      ...(typeof message.error === 'string' ? { error: message.error } : {}),
    }
  } catch {
    return null
  }
}

const encryptNip46WithKey = (
  senderPrivateKey: Uint8Array,
  receiverPubkey: string,
  message: Nip46Message
): string => {
  const conversationKey = nip44.v2.utils.getConversationKey(senderPrivateKey, receiverPubkey)
  return nip44.v2.encrypt(encodeNip46Message(message), conversationKey)
}

const decryptNip46WithKey = (
  receiverPrivateKey: Uint8Array,
  senderPubkey: string,
  content: string
): Nip46Message | null => {
  try {
    const conversationKey = nip44.v2.utils.getConversationKey(receiverPrivateKey, senderPubkey)
    return decodeNip46Message(nip44.v2.decrypt(content, conversationKey))
  } catch {
    return null
  }
}

const decryptNip46AsOwner = async (event: VerifiedEvent): Promise<Nip46Message | null> => {
  const ownerPrivateKey = getPrivkeyBytes()
  if (ownerPrivateKey) {
    return decryptNip46WithKey(ownerPrivateKey, event.pubkey, event.content)
  }
  if (typeof window !== 'undefined' && window.nostr?.nip44?.decrypt) {
    try {
      return decodeNip46Message(await window.nostr.nip44.decrypt(event.pubkey, event.content))
    } catch {
      return null
    }
  }
  return null
}

const signNip46EventWithKey = (
  senderPrivateKey: Uint8Array,
  receiverPubkey: string,
  message: Nip46Message
): VerifiedEvent => {
  return finalizeEvent(
    {
      kind: NIP46_KIND,
      created_at: now(),
      tags: [['p', receiverPubkey]],
      content: encryptNip46WithKey(senderPrivateKey, receiverPubkey, message),
    },
    senderPrivateKey
  ) as VerifiedEvent
}

const signEventAsOwner = async (unsigned: UnsignedEvent): Promise<VerifiedEvent> => {
  const currentIdentity = get(identity)
  if (!currentIdentity?.pubkey) {
    throw new Error('Sign in first.')
  }

  const ownerPrivateKey = getPrivkeyBytes()
  const ownerUnsigned = { ...unsigned, pubkey: currentIdentity.pubkey }
  if (ownerPrivateKey) {
    const { pubkey: _pubkey, ...template } = ownerUnsigned
    return finalizeEvent(template, ownerPrivateKey) as VerifiedEvent
  }
  if (typeof window !== 'undefined' && window.nostr?.signEvent) {
    return window.nostr.signEvent(ownerUnsigned) as Promise<VerifiedEvent>
  }
  throw new Error('This sign-in method cannot link a device here.')
}

const signNip46EventAsOwner = async (
  receiverPubkey: string,
  message: Nip46Message
): Promise<VerifiedEvent> => {
  const currentIdentity = get(identity)
  if (!currentIdentity?.pubkey) {
    throw new Error('Sign in first.')
  }

  const ownerPrivateKey = getPrivkeyBytes()
  let content: string
  if (ownerPrivateKey) {
    content = encryptNip46WithKey(ownerPrivateKey, receiverPubkey, message)
  } else if (typeof window !== 'undefined' && window.nostr?.nip44?.encrypt) {
    content = await window.nostr.nip44.encrypt(receiverPubkey, encodeNip46Message(message))
  } else {
    throw new Error('This sign-in method cannot link a device here.')
  }

  return signEventAsOwner({
    kind: NIP46_KIND,
    pubkey: currentIdentity.pubkey,
    created_at: now(),
    tags: [['p', receiverPubkey]],
    content,
  })
}

const canSignAndEncryptNip46AsOwner = (): boolean => {
  if (getPrivkeyBytes()) return true
  return !!(
    typeof window !== 'undefined' &&
    window.nostr?.signEvent &&
    window.nostr?.nip44?.encrypt &&
    window.nostr?.nip44?.decrypt
  )
}

const publishSignedEventToRelays = async (
  event: VerifiedEvent,
  relayUrls = [...relayStore.getState().relays]
): Promise<void> => {
  const ndkInstance = getNDK()
  const e = new NDKEvent(ndkInstance, event)
  const relays = relayUrls.length > 0 ? relayUrls : [...relayStore.getState().relays]
  const relaySet = NDKRelaySet.fromRelayUrls(relays, ndkInstance, true)
  await e.publish(relaySet, 10000, 1)
}

const signedAppKeysContainsDevice = (
  event: VerifiedEvent,
  ownerPubkey: string,
  devicePubkey: string
): boolean => {
  if (event.pubkey !== ownerPubkey || !verifyEvent(event) || !isAppKeysEvent(event)) {
    return false
  }
  try {
    return AppKeys.fromEvent(event)
      .getAllDevices()
      .some((device) => device.identityPubkey === devicePubkey)
  } catch {
    return false
  }
}

const appKeysRequestForDevice = (ownerPubkey: string, devicePubkey: string): UnsignedEvent => {
  const appKeys = new AppKeys([{ identityPubkey: devicePubkey, createdAt: now() }])
  return {
    ...appKeys.getEvent(),
    pubkey: ownerPubkey,
    created_at: now(),
  }
}

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
  return async (filter) => {
    const events = await ndkInstance.fetchEvents(filter, {
      cacheUsage: NDKSubscriptionCacheUsage.PARALLEL,
    })
    return Array.from(events)
      .map((event) => event.rawEvent() as VerifiedEvent | undefined)
      .filter((event): event is VerifiedEvent => !!event)
  }
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

export const parseNip46LinkDeviceRequest = (
  input: string
): Nip46LinkDeviceRequest | null => {
  const trimmed = input.trim()
  if (!trimmed) return null
  const cleaned = trimmed.startsWith('nostr:') ? trimmed.slice('nostr:'.length) : trimmed

  try {
    const url = new URL(cleaned)
    if (url.protocol !== 'nostrconnect:') return null
    const clientPubkey = url.hostname
    const secret = url.searchParams.get('secret')?.trim() || ''
    const devicePubkey =
      url.searchParams.get('device')?.trim() ||
      url.searchParams.get('device_pubkey')?.trim() ||
      ''
    const perms = url.searchParams.get('perms') || ''
    if (!clientPubkey || !secret || !devicePubkey) return null
    if (!perms.split(',').includes(`sign_event:${APP_KEYS_EVENT_KIND}`)) return null

    return {
      clientPubkey,
      secret,
      devicePubkey,
      relays: url.searchParams.getAll('relay').filter(Boolean),
    }
  } catch {
    return null
  }
}

const buildNip46LinkDeviceUrl = (
  clientPubkey: string,
  secret: string,
  devicePubkey: string,
  relays: string[]
): string => {
  const params = new URLSearchParams()
  relays.forEach((relay) => params.append('relay', relay))
  params.set('secret', secret)
  params.set('perms', `get_public_key,sign_event:${APP_KEYS_EVENT_KIND}`)
  params.set('name', 'Iris Chat')
  params.set('url', 'https://chat.iris.to')
  params.set('image', 'https://chat.iris.to/favicon.png')
  params.set('device', devicePubkey)
  return `nostrconnect://${clientPubkey}?${params.toString()}`
}

export const startNip46LinkDevice = async (
  onAccepted: (ownerPubkey: string) => void | Promise<void>
): Promise<Nip46LinkDeviceSession> => {
  await ensureConnected()
  await initDelegateManager()

  const delegateManager = getDelegateManager()
  const devicePubkey = delegateManager.getIdentityPublicKey()
  const clientPrivateKey = generateSecretKey()
  const clientPubkey = getPublicKey(clientPrivateKey)
  const secret = bytesToHex(generateSecretKey()).slice(0, 16)
  const relays = [...relayStore.getState().relays]
  const url = buildNip46LinkDeviceUrl(clientPubkey, secret, devicePubkey, relays)
  const subscribe = createRelayOnlySubscribe(getNDK())

  let stopped = false
  let completed = false
  let remoteSignerPubkey: string | null = null
  let getPublicKeyRequestId: string | null = null
  let signEventRequestId: string | null = null
  let ownerPubkey: string | null = null

  const publishClientRequest = async (
    receiverPubkey: string,
    method: Exclude<Nip46RequestMethod, 'connect'>,
    params: string[] = []
  ): Promise<string> => {
    const message: Nip46RequestMessage = {
      id: nip46RequestId(),
      method,
      params,
    }
    const event = signNip46EventWithKey(clientPrivateKey, receiverPubkey, message)
    await publishSignedEventToRelays(event, relays)
    return message.id
  }

  const unsubscribe = subscribe(
    {
      kinds: [NIP46_KIND],
      '#p': [clientPubkey],
      since: now() - 30,
    } as NDKFilter,
    async (event) => {
      if (stopped || completed || event.kind !== NIP46_KIND) return
      const message = decryptNip46WithKey(clientPrivateKey, event.pubkey, event.content)
      if (!message) return

      if (isNip46RequestMessage(message)) {
        if (message.method !== 'connect') return
        const [signerPubkey, receivedSecret] = message.params
        if (signerPubkey !== event.pubkey || receivedSecret !== secret) return
        remoteSignerPubkey = signerPubkey
        getPublicKeyRequestId = await publishClientRequest(signerPubkey, 'get_public_key')
        return
      }

      if (message.result === secret && event.pubkey) {
        remoteSignerPubkey = event.pubkey
        getPublicKeyRequestId = await publishClientRequest(event.pubkey, 'get_public_key')
        return
      }

      if (message.id === getPublicKeyRequestId && message.result && !message.error) {
        if (message.result !== event.pubkey || event.pubkey !== remoteSignerPubkey) return
        ownerPubkey = message.result
        const unsigned = appKeysRequestForDevice(ownerPubkey, devicePubkey)
        signEventRequestId = await publishClientRequest(ownerPubkey, 'sign_event', [
          JSON.stringify(unsigned),
        ])
        return
      }

      if (message.id === signEventRequestId && message.result && !message.error) {
        if (!ownerPubkey) return
        let signedEvent: VerifiedEvent
        try {
          signedEvent = JSON.parse(message.result) as VerifiedEvent
        } catch {
          return
        }
        if (!signedAppKeysContainsDevice(signedEvent, ownerPubkey, devicePubkey)) return
        completed = true
        await publishSignedEventToRelays(signedEvent, relays).catch(() => {})
        clearTimeout(timeout)
        unsubscribe()
        await onAccepted(ownerPubkey)
      }
    }
  )

  const timeout = setTimeout(() => {
    stopped = true
    unsubscribe()
  }, NIP46_LINK_TIMEOUT_MS)

  return {
    url,
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

export const acceptNip46LinkDevice = async (input: string): Promise<void> => {
  if (isLinkedDeviceLogin()) {
    throw new Error('Linked devices cannot add devices')
  }

  const request = parseNip46LinkDeviceRequest(input)
  if (!request) {
    throw new Error('Invalid link code')
  }

  const currentIdentity = get(identity)
  if (!currentIdentity?.pubkey) {
    throw new Error('Owner pubkey not available')
  }
  if (!canSignAndEncryptNip46AsOwner()) {
    throw new Error('This sign-in method cannot link a device here.')
  }

  await ensureConnected()
  const currentRuntime = getRuntime()
  await currentRuntime.initForOwner(currentIdentity.pubkey)
  const labels = await getLinkedDeviceRegistrationLabels()
  const prepared = await currentRuntime.prepareRegistrationForIdentity({
    ownerPubkey: currentIdentity.pubkey,
    identityPubkey: request.devicePubkey,
    timeoutMs: APP_KEYS_FETCH_TIMEOUT_MS,
    ...labels,
  })

  const unsigned = {
    ...prepared.appKeys.getEvent(getPrivkeyBytes() ?? undefined),
    pubkey: currentIdentity.pubkey,
  }
  const signedAppKeysEvent = await signEventAsOwner(unsigned)
  if (
    !signedAppKeysContainsDevice(
      signedAppKeysEvent,
      currentIdentity.pubkey,
      request.devicePubkey
    )
  ) {
    throw new Error('Invalid link code')
  }

  const relays = request.relays.length > 0 ? request.relays : [...relayStore.getState().relays]
  await publishSignedEventToRelays(signedAppKeysEvent, relays)
  startNip46AppKeysSigner(request, signedAppKeysEvent, relays)
  await currentRuntime.publishPreparedRegistration(prepared).catch((error) => {
    console.warn('[privateChats] Device roster refresh after NIP-46 link failed:', error)
  })
}

function startNip46AppKeysSigner(
  request: Nip46LinkDeviceRequest,
  signedAppKeysEvent: VerifiedEvent,
  relays: string[]
): void {
  const ownerPubkey = get(identity)?.pubkey
  if (!ownerPubkey) return

  let stopped = false
  let timeout: ReturnType<typeof setTimeout> | null = null
  const subscribe = createRelayOnlySubscribe(getNDK())
  const unsubscribe = subscribe(
    {
      kinds: [NIP46_KIND],
      authors: [request.clientPubkey],
      '#p': [ownerPubkey],
      since: now() - 30,
    } as NDKFilter,
    async (event) => {
      if (stopped || event.kind !== NIP46_KIND || event.pubkey !== request.clientPubkey) {
        return
      }
      const message = await decryptNip46AsOwner(event)
      if (!message || !isNip46RequestMessage(message)) return

      const respond = async (response: Nip46ResponseMessage) => {
        const responseEvent = await signNip46EventAsOwner(request.clientPubkey, response)
        await publishSignedEventToRelays(responseEvent, relays)
      }

      if (message.method === 'get_public_key') {
        await respond({ id: message.id, result: ownerPubkey })
        return
      }

      if (message.method === 'sign_event') {
        let unsigned: UnsignedEvent
        try {
          unsigned = JSON.parse(message.params[0] || '{}') as UnsignedEvent
        } catch {
          return
        }
        const requestedDevice = unsigned.tags?.some(
          (tag) =>
            tag[0] === 'device' &&
            tag[1] === request.devicePubkey &&
            unsigned.kind === APP_KEYS_EVENT_KIND &&
            unsigned.pubkey === ownerPubkey
        )
        await respond(
          requestedDevice
            ? { id: message.id, result: JSON.stringify(signedAppKeysEvent) }
            : { id: message.id, error: 'Invalid device request.' }
        )
        stopped = true
        if (timeout) clearTimeout(timeout)
        unsubscribe()
        return
      }

      if (message.method === 'ping') {
        await respond({ id: message.id, result: 'pong' })
      }
    }
  )

  timeout = setTimeout(() => {
    stopped = true
    unsubscribe()
  }, NIP46_LINK_TIMEOUT_MS)

  void signNip46EventAsOwner(request.clientPubkey, {
    id: nip46RequestId(),
    method: 'connect',
    params: [ownerPubkey, request.secret],
  })
    .then((event) => publishSignedEventToRelays(event, relays))
    .catch((error) => {
      console.warn('[privateChats] Failed to start NIP-46 signer:', error)
      clearTimeout(timeout)
      stopped = true
      unsubscribe()
    })
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

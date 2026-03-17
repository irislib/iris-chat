import { get } from 'svelte/store'
import { NDKEvent, NDKSubscriptionCacheUsage, type NDKFilter } from '@nostr-dev-kit/ndk'
import {
  AppKeysManager,
  applyAppKeysSnapshot,
  buildAppKeysFilter,
  DelegateManager,
  evaluateDeviceRegistrationState,
  SessionManager,
  AppKeys,
  Invite,
  INVITE_RESPONSE_KIND,
  shouldRequireRelayRegistrationConfirmation,
  type DeviceEntry,
  type NostrSubscribe,
  type NostrPublish,
  decryptInviteResponse,
} from 'nostr-double-ratchet'
import { finalizeEvent } from 'nostr-tools'
import { ndk, identity, isLinkedDeviceLogin } from './identity'
import { devices } from './devices'
import { asNdkEventSubscription } from './ndkSubscription'
import { DexieStorageAdapter } from './sessionManagerStorage'

let appKeysManager: AppKeysManager | null = null
let delegateManager: DelegateManager | null = null
let sessionManager: SessionManager | null = null

let appKeysInitPromise: Promise<void> | null = null
let delegateInitPromise: Promise<void> | null = null
let sessionManagerInitPromise: Promise<void> | null = null

let appKeysSubscriptionCleanup: (() => void) | null = null
let rotateInvitePromise: Promise<void> | null = null
let linkedInviteRepublishTimer: ReturnType<typeof setTimeout> | null = null

const APP_KEYS_FETCH_TIMEOUT_MS = 8000
const APP_KEYS_FAST_TIMEOUT_MS = 2000
const LINKED_INVITE_REPUBLISH_RETRY_MS = 1500

const cloneAppKeys = (appKeys: AppKeys): AppKeys => new AppKeys(appKeys.getAllDevices())

const resolveBaseAppKeys = async (
  ownerPubkey: string,
  timeoutMs: number = APP_KEYS_FETCH_TIMEOUT_MS
): Promise<AppKeys> => {
  const nostrSubscribe = createSubscribe(getNDK())
  try {
    const existingKeys = await AppKeys.waitFor(
      ownerPubkey,
      nostrSubscribe,
      APP_KEYS_FAST_TIMEOUT_MS
    )
    if (existingKeys) {
      return existingKeys
    }
  } catch {
    // ignore fetch errors, fall back to local sources
  }

  const localKeys = appKeysManager?.getAppKeys()
  if (localKeys && localKeys.getAllDevices().length > 0) {
    return cloneAppKeys(localKeys)
  }

  const { registeredDevices } = get(devices)
  if (registeredDevices.length > 0) {
    return new AppKeys(registeredDevices)
  }

  if (timeoutMs > APP_KEYS_FAST_TIMEOUT_MS) {
    try {
      const remaining = Math.max(timeoutMs - APP_KEYS_FAST_TIMEOUT_MS, 0)
      const existingKeys = await AppKeys.waitFor(ownerPubkey, nostrSubscribe, remaining)
      if (existingKeys) {
        return existingKeys
      }
    } catch {
      // ignore fetch errors
    }
  }

  return new AppKeys()
}

const createSubscribe = (
  ndkInstance: ReturnType<typeof getNDK>,
  cacheUsage: NDKSubscriptionCacheUsage = NDKSubscriptionCacheUsage.PARALLEL
): NostrSubscribe => {
  return (filter, onEvent) => {
    const relayUrls = ndkInstance.pool.connectedRelays().map((relay) => relay.url)
    const subscription = asNdkEventSubscription(ndkInstance.subscribe(filter, {
      closeOnEose: false,
      cacheUsage,
      ...(relayUrls.length > 0 ? { relayUrls } : {}),
    }))
    subscription.on('event', (event: NDKEvent) => {
      onEvent(event.rawEvent() as Parameters<typeof onEvent>[0])
    })
    subscription.start()
    return () => subscription.stop()
  }
}

const waitForCurrentDeviceRegistrationOnRelay = async (
  ownerPubkey: string,
  devicePubkey: string,
  timeoutMs: number = APP_KEYS_FETCH_TIMEOUT_MS
): Promise<void> => {
  const relaySubscribe = createSubscribe(getNDK(), NDKSubscriptionCacheUsage.ONLY_RELAY)
  const appKeys = await AppKeys.waitFor(ownerPubkey, relaySubscribe, timeoutMs)
  const isAuthorized =
    appKeys?.getAllDevices().some((device) => device.identityPubkey === devicePubkey) ?? false

  if (!isAuthorized) {
    throw new Error(`Relay AppKeys for ${ownerPubkey} do not include current device ${devicePubkey}`)
  }
}

const createPublish = (ndkInstance: ReturnType<typeof getNDK>): NostrPublish => {
  return (async (event) => {
    const e = new NDKEvent(ndkInstance, event)
    await e.publish()
    return event as never
  }) as NostrPublish
}

function getNDK() {
  return get(ndk)
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

export const initAppKeysManager = async (): Promise<void> => {
  if (appKeysInitPromise) {
    await appKeysInitPromise
    return
  }
  if (appKeysManager) return

  appKeysInitPromise = (async () => {
    const ndkInstance = getNDK()
    const storage = new DexieStorageAdapter()

    appKeysManager = new AppKeysManager({
      nostrPublish: createPublish(ndkInstance),
      storage,
    })

    await appKeysManager.init()

    const appKeys = appKeysManager.getAppKeys()
    devices.setHasLocalAppKeys(!!(appKeys && appKeys.getAllDevices().length > 0))
    devices.setRegisteredDevices(appKeysManager.getOwnDevices())
    devices.setAppKeysManagerReady(true)
  })()

  await appKeysInitPromise
}

export const initDelegateManager = async (): Promise<void> => {
  if (delegateInitPromise) {
    await delegateInitPromise
    return
  }
  if (delegateManager) return

  delegateInitPromise = (async () => {
    const ndkInstance = getNDK()
    const storage = new DexieStorageAdapter()

    delegateManager = new DelegateManager({
      nostrSubscribe: createSubscribe(ndkInstance),
      nostrPublish: createPublish(ndkInstance),
      storage,
    })

    await delegateManager.init()
    devices.setIdentityPubkey(delegateManager.getIdentityPublicKey())
  })()

  await delegateInitPromise
}

export const initSessionManager = async (ownerPubkey: string): Promise<void> => {
  if (sessionManagerInitPromise) {
    await sessionManagerInitPromise
    return
  }
  if (sessionManager) return

  sessionManagerInitPromise = (async () => {
    if (!delegateManager) {
      throw new Error('DelegateManager not initialized')
    }

    await delegateManager.activate(ownerPubkey)
    sessionManager = delegateManager.createSessionManager(new DexieStorageAdapter())
    await sessionManager.init()
    devices.setSessionManagerReady(true)
  })()

  await sessionManagerInitPromise
}

export const waitForSessionManager = async (): Promise<SessionManager> => {
  // In some flows (e.g. "Join Chat" from URL right after login), callers may try to
  // send via SessionManager before initMultiDevice() has finished. Make this helper
  // resilient by lazily initializing the SessionManager when possible.
  if (!sessionManagerInitPromise || !sessionManager) {
    // SessionManager creation depends on DelegateManager state and (indirectly) the
    // AppKeys / invite material kept in the same storage adapter. Initialize both
    // managers first to avoid transient "missing invite" errors in fresh sessions.
    await Promise.all([initAppKeysManager(), initDelegateManager()])
    const ownerPubkey = delegateManager?.getOwnerPublicKey() || get(identity)?.pubkey
    if (ownerPubkey) {
      await initSessionManager(ownerPubkey)
    }
  }

  if (sessionManagerInitPromise) await sessionManagerInitPromise
  if (!sessionManager) throw new Error('SessionManager not initialized')
  return sessionManager
}

export const getSessionManager = (): SessionManager | null => sessionManager

export const getDelegateManager = (): DelegateManager => {
  if (!delegateManager) throw new Error('DelegateManager not initialized')
  return delegateManager
}

export const getAppKeysManager = (): AppKeysManager => {
  if (!appKeysManager) throw new Error('AppKeysManager not initialized')
  return appKeysManager
}

export const initMultiDevice = async (ownerPubkey: string): Promise<void> => {
  await Promise.all([initAppKeysManager(), initDelegateManager()])
  await initSessionManager(ownerPubkey)
  const ndkInstance = getNDK()
  if (ndkInstance.pool.connectedRelays().length === 0) {
    await ndkInstance.pool.connect(5000)
  }
  startAppKeysSubscription(ownerPubkey)

  let linkedDeviceAuthorized = get(devices).isCurrentDeviceRegistered
  let currentDevicePubkey = delegateManager?.getIdentityPublicKey() ?? null
  if (isLinkedDeviceLogin() && delegateManager && appKeysManager) {
    try {
      const baseKeys = await resolveBaseAppKeys(ownerPubkey)
      await appKeysManager.setAppKeys(baseKeys)
      devices.setHasLocalAppKeys(baseKeys.getAllDevices().length > 0)
      devices.setRegisteredDevices(appKeysManager.getOwnDevices(), Math.floor(Date.now() / 1000))
      currentDevicePubkey = delegateManager.getIdentityPublicKey()
      linkedDeviceAuthorized = baseKeys
        .getAllDevices()
        .some((device) => device.identityPubkey === currentDevicePubkey)
    } catch (e) {
      console.warn('[privateChats] Failed to hydrate linked-device AppKeys state:', e)
    }
  }

  if (
    isLinkedDeviceLogin() &&
    delegateManager &&
    appKeysManager &&
    currentDevicePubkey &&
    !linkedDeviceAuthorized
  ) {
    try {
      const refreshedKeys = await AppKeys.waitFor(
        ownerPubkey,
        createSubscribe(getNDK()),
        APP_KEYS_FETCH_TIMEOUT_MS
      )
      if (refreshedKeys) {
        const previousState = get(devices)
        await appKeysManager.setAppKeys(refreshedKeys)
        devices.setHasLocalAppKeys(refreshedKeys.getAllDevices().length > 0)
        devices.setRegisteredDevices(
          appKeysManager.getOwnDevices(),
          Math.floor(Date.now() / 1000)
        )
        linkedDeviceAuthorized = refreshedKeys
          .getAllDevices()
          .some((device) => device.identityPubkey === currentDevicePubkey)

        if (
          linkedDeviceAuthorized &&
          !previousState.isCurrentDeviceRegistered &&
          get(devices).isCurrentDeviceRegistered
        ) {
          await republishInviteWithRetry('linked device authorization backfill')
        }
      }
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
  if (!appKeysManager) return false
  const appKeys = appKeysManager.getAppKeys()
  return !!(appKeys && appKeys.getAllDevices().length > 0)
}

export const registerDevice = async (): Promise<void> => {
  if (isLinkedDeviceLogin()) {
    throw new Error('Linked devices cannot register other devices')
  }
  if (!delegateManager || !appKeysManager) {
    await Promise.all([initAppKeysManager(), initDelegateManager()])
  }
  if (!delegateManager || !appKeysManager) {
    throw new Error('Managers not initialized')
  }

  const ownerPubkey = delegateManager.getOwnerPublicKey() || get(identity)?.pubkey
  if (!ownerPubkey) {
    throw new Error('Owner pubkey not available')
  }
  if (!delegateManager.getOwnerPublicKey()) {
    await delegateManager.activate(ownerPubkey)
  }

  const ndkInstance = getNDK()
  if (ndkInstance.pool.connectedRelays().length === 0) {
    await ndkInstance.pool.connect(5000)
  }

  const baseKeys = await resolveBaseAppKeys(ownerPubkey)
  const knownDevices = baseKeys
    .getAllDevices()
    .map((device) => device.identityPubkey)
  const shouldConfirmOnRelay = shouldRequireRelayRegistrationConfirmation({
    currentDevicePubkey: delegateManager.getIdentityPublicKey(),
    registeredDevices: baseKeys.getAllDevices(),
    hasLocalAppKeys: knownDevices.length > 0,
    appKeysManagerReady: true,
    sessionManagerReady: true,
  })
  await appKeysManager.setAppKeys(baseKeys)

  const payload = delegateManager.getRegistrationPayload()
  appKeysManager.addDevice(payload)
  await appKeysManager.publish()

  devices.setHasLocalAppKeys(true)
  devices.setRegisteredDevices(appKeysManager.getOwnDevices(), Math.floor(Date.now() / 1000))

  if (shouldConfirmOnRelay) {
    await waitForCurrentDeviceRegistrationOnRelay(
      ownerPubkey,
      payload.identityPubkey,
      APP_KEYS_FETCH_TIMEOUT_MS
    )
  }
}

/**
 * Register a specific device identity in AppKeys.
 * Used when linking a new device via private link invite.
 */
export const registerLinkedDevice = async (identityPubkey: string): Promise<void> => {
  if (isLinkedDeviceLogin()) {
    throw new Error('Linked devices cannot register other devices')
  }
  if (!appKeysManager) {
    throw new Error('AppKeysManager not initialized')
  }

  const ownerPubkey = get(identity)?.pubkey
  if (!ownerPubkey) {
    throw new Error('Owner pubkey not available')
  }

  const ndkInstance = getNDK()
  if (ndkInstance.pool.connectedRelays().length === 0) {
    await ndkInstance.pool.connect(5000)
  }

  const baseKeys = await resolveBaseAppKeys(ownerPubkey)
  await appKeysManager.setAppKeys(baseKeys)

  appKeysManager.addDevice({ identityPubkey })
  await appKeysManager.publish()

  devices.setHasLocalAppKeys(true)
  devices.setRegisteredDevices(appKeysManager.getOwnDevices(), Math.floor(Date.now() / 1000))
}

/**
 * Create a private link invite for this device.
 */
export const createLinkInvite = async (): Promise<Invite> => {
  await initDelegateManager()
  if (!delegateManager) {
    throw new Error('DelegateManager not initialized')
  }
  const baseInvite = delegateManager.getInvite()
  if (!baseInvite) {
    throw new Error('DelegateManager invite not initialized')
  }
  const invite = Invite.deserialize(baseInvite.serialize())
  ;(invite as Invite & { purpose?: string }).purpose = 'link'
  return invite
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
  url.hash = encodeURIComponent(JSON.stringify(data))
  return url.toString()
}

/**
 * Listen for acceptance of a link invite.
 */
export const listenForLinkInviteAcceptance = (
  invite: Invite,
  onAccepted: (ownerPubkey: string) => void
): (() => void) => {
  if (!delegateManager) {
    throw new Error('DelegateManager not initialized')
  }
  if (!invite.inviterEphemeralPrivateKey) {
    throw new Error('Invite missing ephemeral private key')
  }

  const inviterPrivateKey = delegateManager.getIdentityKey()
  const ndkInstance = getNDK()
  const subscribe = createSubscribe(ndkInstance)

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

        const ownerPubkey = decrypted.ownerPublicKey || decrypted.inviteeIdentity
        onAccepted(ownerPubkey)
      } catch {
        // ignore invalid responses
      }
    }
  )
}

export const ensureDeviceRegistered = async (): Promise<void> => {
  if (isLinkedDeviceLogin()) {
    return
  }
  if (!delegateManager || !appKeysManager) {
    await Promise.all([initAppKeysManager(), initDelegateManager()])
  }

  if (!delegateManager || !appKeysManager) {
    throw new Error('Managers not initialized')
  }

  const ownerPubkey = delegateManager.getOwnerPublicKey() || get(identity)?.pubkey
  if (!ownerPubkey) {
    throw new Error('Owner pubkey not available')
  }
  const currentDevicePubkey = delegateManager.getIdentityPublicKey()
  const state = get(devices)
  const currentState = evaluateDeviceRegistrationState({
    currentDevicePubkey,
    registeredDevices: state.registeredDevices,
    hasLocalAppKeys: state.hasLocalAppKeys,
    appKeysManagerReady: state.appKeysManagerReady,
    sessionManagerReady: state.sessionManagerReady,
  })
  if (!currentState.isCurrentDeviceRegistered || state.hasLocalAppKeys) {
    await registerDevice()
  }

  await republishInvite().catch(() => {})
}

export const revokeDevice = async (identityPubkey: string): Promise<void> => {
  if (!appKeysManager) {
    throw new Error('AppKeysManager not initialized')
  }

  const ownerPubkey = delegateManager?.getOwnerPublicKey()
  if (ownerPubkey) {
    const nostrSubscribe = createSubscribe(getNDK())
    const existingKeys = await AppKeys.waitFor(ownerPubkey, nostrSubscribe, 2000)
    if (existingKeys) {
      await appKeysManager.setAppKeys(existingKeys)
    }
  }

  appKeysManager.revokeDevice(identityPubkey)
  await appKeysManager.publish()

  devices.setHasLocalAppKeys(appKeysManager.getOwnDevices().length > 0)
  devices.setRegisteredDevices(appKeysManager.getOwnDevices(), Math.floor(Date.now() / 1000))
}

export const startAppKeysSubscription = (ownerPubkey: string): void => {
  if (appKeysSubscriptionCleanup) return

  const ndkInstance = getNDK()
  const subscription = asNdkEventSubscription(
    ndkInstance.subscribe(buildAppKeysFilter(ownerPubkey) as NDKFilter)
  )

  subscription.on('event', async (event: NDKEvent) => {
    try {
      const previousState = get(devices)
      const eventTime = event.created_at ?? 0
      const { lastEventTimestamp } = previousState

      const incomingAppKeys = AppKeys.fromEvent(event.rawEvent() as never)
      if (appKeysManager) {
        const nextSnapshot = applyAppKeysSnapshot({
          currentAppKeys: appKeysManager.getAppKeys(),
          currentCreatedAt: lastEventTimestamp,
          incomingAppKeys,
          incomingCreatedAt: eventTime,
        })
        if (nextSnapshot.decision === 'stale') return

        await appKeysManager.setAppKeys(nextSnapshot.appKeys)
        devices.setHasLocalAppKeys(appKeysManager.getOwnDevices().length > 0)
        devices.setRegisteredDevices(
          appKeysManager.getOwnDevices(),
          nextSnapshot.createdAt
        )

        const nextState = get(devices)
        if (
          isLinkedDeviceLogin() &&
          !previousState.isCurrentDeviceRegistered &&
          nextState.isCurrentDeviceRegistered
        ) {
          void republishInviteWithRetry('linked device registration').catch((err) => {
            console.warn('[privateChats] Republish invite after linked registration failed:', err)
          })
        }
      }
    } catch (err) {
      console.error('[privateChats] Failed to process AppKeys event:', err)
    }
  })

  subscription.start()
  appKeysSubscriptionCleanup = () => subscription.stop()
}

export const stopAppKeysSubscription = (): void => {
  if (appKeysSubscriptionCleanup) {
    appKeysSubscriptionCleanup()
    appKeysSubscriptionCleanup = null
  }
}

export const resetManagers = (): void => {
  if (linkedInviteRepublishTimer) {
    clearTimeout(linkedInviteRepublishTimer)
    linkedInviteRepublishTimer = null
  }
  appKeysManager?.close?.()
  delegateManager?.close?.()
  sessionManager?.close()
  appKeysManager = null
  delegateManager = null
  sessionManager = null
  appKeysInitPromise = null
  delegateInitPromise = null
  sessionManagerInitPromise = null
  appKeysSubscriptionCleanup = null
  devices.reset()
}

export const republishInvite = async (): Promise<void> => {
  if (!delegateManager) {
    throw new Error('DelegateManager not initialized')
  }
  const ndkInstance = getNDK()
  if (ndkInstance.pool.connectedRelays().length === 0) {
    await ndkInstance.pool.connect(5000)
  }
  await delegateManager.publishInvite()
}

export const rotateDeviceInvite = async (): Promise<void> => {
  if (rotateInvitePromise) return rotateInvitePromise

  rotateInvitePromise = (async () => {
    if (!delegateManager) {
      await initDelegateManager()
    }
    if (!delegateManager) {
      throw new Error('DelegateManager not initialized')
    }

    const ndkInstance = getNDK()
    if (ndkInstance.pool.connectedRelays().length === 0) {
      await ndkInstance.pool.connect(5000)
    }

    await delegateManager.rotateInvite()
  })().finally(() => {
    rotateInvitePromise = null
  })

  return rotateInvitePromise
}

export const getRegisteredDevices = (): DeviceEntry[] => {
  return appKeysManager?.getOwnDevices() || []
}

// Accept a link invite as the owner and publish the response event.
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

  const ndkInstance = getNDK()
  if (ndkInstance.pool.connectedRelays().length === 0) {
    await ndkInstance.pool.connect(5000)
  }

  const manager = getSessionManager() ?? (await waitForSessionManager())
  await manager.acceptInvite(invite, {
    ownerPublicKey: currentIdentity.pubkey,
  })
}

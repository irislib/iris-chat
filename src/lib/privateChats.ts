import { get } from 'svelte/store'
import { NDKEvent, type NDKFilter } from '@nostr-dev-kit/ndk'
import {
  AppKeysManager,
  DelegateManager,
  SessionManager,
  AppKeys,
  Invite,
  INVITE_RESPONSE_KIND,
  type DeviceEntry,
  type NostrSubscribe,
  type NostrPublish,
  decryptInviteResponse,
} from 'nostr-double-ratchet'
import { finalizeEvent } from 'nostr-tools'
import { ndk, identity, isLinkedDeviceLogin } from './identity'
import { devices } from './devices'
import { DexieStorageAdapter } from './sessionManagerStorage'

let appKeysManager: AppKeysManager | null = null
let delegateManager: DelegateManager | null = null
let sessionManager: SessionManager | null = null

let appKeysInitPromise: Promise<void> | null = null
let delegateInitPromise: Promise<void> | null = null
let sessionManagerInitPromise: Promise<void> | null = null

let appKeysSubscriptionCleanup: (() => void) | null = null

const createSubscribe = (ndkInstance: ReturnType<typeof getNDK>): NostrSubscribe => {
  return (filter, onEvent) => {
    const subscription = ndkInstance.subscribe(filter, { closeOnEose: false })
    subscription.on('event', (event: NDKEvent) => {
      onEvent(event.rawEvent() as Parameters<typeof onEvent>[0])
    })
    subscription.start()
    return () => subscription.stop()
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

export const initAppKeysManager = async (): Promise<void> => {
  if (appKeysManager) return
  if (appKeysInitPromise) return appKeysInitPromise

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
  if (delegateManager) return
  if (delegateInitPromise) return delegateInitPromise

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
  if (sessionManager) return
  if (sessionManagerInitPromise) return sessionManagerInitPromise

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
  startAppKeysSubscription(ownerPubkey)

  const deviceState = get(devices)
  if (!isLinkedDeviceLogin() && !deviceState.hasLocalAppKeys && !deviceState.isCurrentDeviceRegistered) {
    try {
      await registerDevice()
    } catch (e) {
      console.warn('[privateChats] Auto-registration failed:', e)
    }
  }

  try {
    await republishInvite()
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
    throw new Error('Managers not initialized')
  }

  const ndkInstance = getNDK()
  if (ndkInstance.pool.connectedRelays().length === 0) {
    await ndkInstance.pool.connect(5000)
  }

  const ownerPubkey = delegateManager.getOwnerPublicKey()
  if (!ownerPubkey) {
    throw new Error('Owner pubkey not available')
  }

  // Fetch existing AppKeys from relay first to avoid overwriting
  const nostrSubscribe = createSubscribe(getNDK())
  const existingKeys = await AppKeys.waitFor(ownerPubkey, nostrSubscribe, 2000)

  if (existingKeys) {
    await appKeysManager.setAppKeys(existingKeys)
  }

  const payload = delegateManager.getRegistrationPayload()
  appKeysManager.addDevice(payload)
  await appKeysManager.publish()

  devices.setHasLocalAppKeys(true)
  devices.setRegisteredDevices(appKeysManager.getOwnDevices(), Math.floor(Date.now() / 1000))
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

  const nostrSubscribe = createSubscribe(getNDK())
  const existingKeys = await AppKeys.waitFor(ownerPubkey, nostrSubscribe, 2000)
  if (existingKeys) {
    await appKeysManager.setAppKeys(existingKeys)
  }

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
  const devicePubkey = delegateManager.getIdentityPublicKey()
  return Invite.createNew(devicePubkey, undefined, undefined, {
    purpose: 'link',
  })
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

  const ownerPubkey = delegateManager.getOwnerPublicKey()
  if (!ownerPubkey) {
    throw new Error('Owner pubkey not available')
  }

  const state = get(devices)
  if (!state.isCurrentDeviceRegistered) {
    await registerDevice()
  } else {
    const ndkInstance = getNDK()
    if (ndkInstance.pool.connectedRelays().length === 0) {
      await ndkInstance.pool.connect(5000)
    }
    await appKeysManager.publish().catch(() => {})
  }

  const nostrSubscribe = createSubscribe(getNDK())
  await AppKeys.waitFor(ownerPubkey, nostrSubscribe, 4000).catch(() => null)

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
  const subscription = ndkInstance.subscribe({
    kinds: [30078],
    authors: [ownerPubkey],
    '#d': ['double-ratchet/app-keys'],
  } as NDKFilter)

  subscription.on('event', async (event: NDKEvent) => {
    try {
      const eventTime = event.created_at ?? 0
      const { lastEventTimestamp } = get(devices)
      if (eventTime <= lastEventTimestamp) return

      const incomingAppKeys = AppKeys.fromEvent(event.rawEvent() as never)
      if (appKeysManager) {
        await appKeysManager.setAppKeys(incomingAppKeys)
        devices.setHasLocalAppKeys(appKeysManager.getOwnDevices().length > 0)
        devices.setRegisteredDevices(appKeysManager.getOwnDevices(), eventTime)
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

export const getInviteDetails = () => {
  if (!delegateManager) return null
  const invite = delegateManager.getInvite()
  if (!invite) return null
  return {
    ephemeralPublicKey: invite.inviterEphemeralPublicKey,
    sharedSecret: invite.sharedSecret,
    deviceId: invite.deviceId || delegateManager.getIdentityPublicKey(),
    createdAt: invite.createdAt,
  }
}

export const republishInvite = async (): Promise<void> => {
  if (!delegateManager) {
    throw new Error('DelegateManager not initialized')
  }

  const invite = delegateManager.getInvite()
  if (!invite) {
    throw new Error('No invite available')
  }

  const unsignedEvent = invite.getEvent()
  const signedEvent = finalizeEvent(unsignedEvent, delegateManager.getIdentityKey())

  const ndkInstance = getNDK()
  if (ndkInstance.pool.connectedRelays().length === 0) {
    await ndkInstance.pool.connect(5000)
  }

  const event = new NDKEvent(ndkInstance, signedEvent)
  await event.publish()
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

  const ndkInstance = getNDK()
  if (ndkInstance.pool.connectedRelays().length === 0) {
    await ndkInstance.pool.connect(5000)
  }

  const signer = currentIdentity.signer ?? ndkInstance.signer
  if (!signer) {
    throw new Error('No signer available to accept link invite')
  }

  const encrypt = async (plaintext: string, pubkey: string) => {
    const user = ndkInstance.getUser({ pubkey })
    return signer.encrypt(user, plaintext, 'nip44')
  }

  const nostrSubscribe = createSubscribe(ndkInstance)
  const { event } = await invite.accept(
    nostrSubscribe,
    currentIdentity.pubkey,
    encrypt,
    currentIdentity.pubkey
  )

  const ndkEvent = new NDKEvent(ndkInstance, event)
  await ndkEvent.publish()
}

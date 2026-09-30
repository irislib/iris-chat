import { getPublicKey } from 'nostr-tools'
import { db } from './storage'
import { identity, loginLinkedDevice, nostrClient } from './identity'
import { get } from 'svelte/store'
import { relayStore } from './relayStore'
import { RemoteSigner, type RemoteSignerOptions } from './remoteSigner'
import { authorizeSignerDevice } from './signerAuthorization'
import { SIGNER_PROOF_KEY } from './signerAuthorizationStorage'

const DEVICE_PREFIX = 'v1/device-manager'

export async function loginWithRemoteSigner(options: Omit<RemoteSignerOptions, 'relays' | 'runtime'> & { onCommitting?: () => void }): Promise<void> {
  if (get(identity)) throw new Error('Already signed in.')
  const relays = [...relayStore.getState().relays]
  const runtime = get(nostrClient).runtime
  const signer = new RemoteSigner({ ...options, relays, runtime })
  let deviceSecret: Uint8Array | undefined
  try {
    const owner = await signer.connect()
    const authorization = await authorizeSignerDevice({
      owner, relays, runtime, signal: options.signal, signEvent: event => signer.signEvent(event),
      onCommitting: () => {
        signer.ensureActive()
        if (get(identity)) throw new Error('Already signed in.')
        options.onCommitting?.()
        signer.close()
      },
    })
    deviceSecret = authorization.deviceSecret
    // The exact signed proof and device key commit together. The identity
    // marker is written only afterward; no owner or signer secret is retained.
    await db.transaction('rw', db.sessionManager, async () => {
      await db.sessionManager.bulkPut([
        { key: SIGNER_PROOF_KEY, value: authorization.event },
        { key: `${DEVICE_PREFIX}/identity-public-key`, value: getPublicKey(deviceSecret!) },
        { key: `${DEVICE_PREFIX}/identity-private-key`, value: Array.from(deviceSecret!) },
        { key: `${DEVICE_PREFIX}/owner-pubkey`, value: owner },
      ])
      await db.sessionManager.delete(`${DEVICE_PREFIX}/invite`)
    })
    await loginLinkedDevice(owner)
  } finally {
    deviceSecret?.fill(0)
    signer.close()
  }
}

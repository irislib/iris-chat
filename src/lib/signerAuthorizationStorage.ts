import { AppKeys, type NdrRuntime } from 'nostr-double-ratchet'
import type { VerifiedEvent } from 'nostr-tools'
import { getSessionManagerValue } from './storage'

export const SIGNER_PROOF_KEY = 'iris/signer-device-authorization'

export async function restoreSignerAuthorization(runtime: NdrRuntime, owner: string): Promise<void> {
  const proof = await getSessionManagerValue<VerifiedEvent>(SIGNER_PROOF_KEY)
  if (!proof || proof.pubkey !== owner) return
  const appKeys = AppKeys.fromEvent(proof)
  const device = runtime.getState().currentDevicePubkey
  if (!device || !appKeys.getDevice(device)) return
  // Honor subsequent revocations already persisted by the messaging runtime.
  const current = runtime.getSessionManager()?.getKnownAppKeysSnapshots().find(snapshot => snapshot.ownerPubkey === owner)
  if (current && current.createdAt === proof.created_at) {
    const roster = (keys: AppKeys) => JSON.stringify(keys.getAllDevices().map(entry => [entry.identityPubkey, entry.createdAt]).sort())
    if (roster(current.appKeys) !== roster(appKeys)) {
      runtime.close()
      throw new Error('Conflicting device authorization. Please sign in again.')
    }
  }
  if (current && current.createdAt > proof.created_at) {
    await runtime.applyTrustedAppKeysSnapshot(current)
    return
  }
  await runtime.applyTrustedAppKeysSnapshot({ ownerPubkey: owner, appKeys, createdAt: proof.created_at })
  runtime.feedEvent(proof)
}

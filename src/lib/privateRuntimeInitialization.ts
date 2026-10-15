import type { NdrRuntime } from 'nostr-double-ratchet'

/** Restore durable authorization before exposing live roster changes. */
export async function initializeAuthorizedRuntime(
  runtime: NdrRuntime,
  owner: string,
  restoreAuthorization: () => Promise<void>,
): Promise<void> {
  // NDR restores the AppKeysManager's device list without its version. Starting
  // its live roster subscription at that point lets an older relay/cache event
  // appear newer than version zero and revoke a legitimately linked device.
  // The SessionManager already persists the corresponding versioned snapshot.
  await runtime.initManagers()
  const manager = await runtime.initSessionManager(owner)
  const own = manager.getKnownAppKeysSnapshots().find(snapshot => snapshot.ownerPubkey === owner)
  if (own) await runtime.applyTrustedAppKeysSnapshot(own)
  await restoreAuthorization()
  await runtime.initForOwner(owner)
}

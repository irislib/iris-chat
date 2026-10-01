import type { NdrRuntime, OnEventMeta, Rumor } from 'nostr-double-ratchet'
import type { DeviceState } from './devices'

const durableKinds = [10449, 10450, 10452, 10453]
const pendingRosterReads = new Map<string, number>()

type Options = {
  account: string | null
  getAccount(): string | null
  getState(): DeviceState
  receive(rumor: Rumor, from: string, meta?: OnEventMeta): Promise<void>
}

/** The registered application callback determines when the durable inbox can ACK. */
export function registerPrivateControlEvents(
  runtime: Pick<NdrRuntime, 'onDurableSessionEvent' | 'refreshOwnAppKeysFromRelay'>,
  options: Options,
): () => void {
  const { account } = options
  return runtime.onDurableSessionEvent(durableKinds, async (rumor, from, meta) => {
    if (!account || options.getAccount() !== account) throw new Error('Private account is not ready')
    const state = options.getState()
    if (!state.sessionManagerReady || !state.appKeysManagerReady || (!state.hasLocalAppKeys && state.lastEventTimestamp <= 0)) throw new Error('Device list is not ready')
    const sender = meta?.senderDevicePubkey || meta?.fromDeviceId
    // Older native builders omit self p tags. The authenticated sibling account
    // is authoritative; any explicit recipient must still be that account.
    if (from !== account || meta?.senderOwnerPubkey !== account || !sender || sender === state.identityPubkey ||
      (rumor.pubkey !== account && rumor.pubkey !== sender) ||
      rumor.tags.some(tag => tag[0] === 'p' && tag[1] !== account)) return
    if (!state.isCurrentDeviceRegistered || !state.registeredDevices.some(device => device.identityPubkey === sender)) {
      if (Date.now() - (pendingRosterReads.get(account) ?? 0) > 30_000) {
        pendingRosterReads.set(account, Date.now())
        void runtime.refreshOwnAppKeysFromRelay(account).catch(() => {})
      }
      throw new Error('Waiting for the linked device list')
    }
    await options.receive(rumor, from, meta)
    if (options.getAccount() !== account) throw new Error('Account changed')
  })
}

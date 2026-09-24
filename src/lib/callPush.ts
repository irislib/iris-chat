import { finalizeEvent, nip44, type VerifiedEvent } from 'nostr-tools'
import { CALL_CODEC } from './callProtocol'

export const CALL_WAKE_KIND = 21111

export function callWakeEvent(secretKey: Uint8Array, recipient: string, callId: string, video: boolean): VerifiedEvent {
  const key = nip44.v2.utils.getConversationKey(secretKey, recipient)
  const content = nip44.v2.encrypt(JSON.stringify({ v: 3, type: 'offer', call_id: callId, video, muted: false, codec: CALL_CODEC }), key)
  return finalizeEvent({ kind: CALL_WAKE_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['p', recipient]], content }, secretKey)
}

// This is only a wakeup. FIPS carries the live call, including hangup/liveness.
export async function sendCallWakeups(secretKey: Uint8Array, peers: string[], callId: string, video: boolean,
  serverUrl: string, publish: (event: VerifiedEvent) => Promise<unknown>): Promise<void> {
  await Promise.allSettled([...new Set(peers.map(peer => peer.slice(2)))].map(async recipient => {
    if (!/^[0-9a-f]{64}$/.test(recipient)) return
    const event = callWakeEvent(secretKey, recipient, callId, video)
    await Promise.allSettled([
      publish(event),
      fetch(`${serverUrl.replace(/\/$/, '')}/events`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event), signal: AbortSignal.timeout(5000),
      }),
    ])
  }))
}

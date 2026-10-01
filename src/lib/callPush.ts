import { finalizeEvent, getEventHash, verifyEvent, type VerifiedEvent } from 'nostr-tools'
import { Invite, type Rumor } from 'nostr-double-ratchet'
import { CALL_CODEC, validCallId } from './callProtocol'

export const CALL_WAKE_KIND = 21111
export const CALL_WAKE_SIGNAL_KIND = 21112
const WAKE_LIFETIME_MS = 40_000
const invites = new Map<string, { ephemeral: string; observed: number; createdAt: number; id: string }>()
const bootstraps = new Map<string, { event: VerifiedEvent; observed: number; acknowledged: boolean }>()
/** Public invite metadata only; needed to route the one bootstrap for a cold peer. */
export function observeCallWakeInvite(event: VerifiedEvent): void {
  if (event.kind !== 30078 || !event.tags.some(tag => tag[0] === 'd' && tag[1]?.startsWith('double-ratchet/invites/'))) return
  try {
    const invite = Invite.fromEvent(event)
    const previous = invites.get(event.pubkey)
    if (previous && (previous.createdAt > event.created_at || (previous.createdAt === event.created_at && previous.id <= event.id))) return
    invites.delete(event.pubkey)
    invites.set(event.pubkey, { ephemeral: invite.inviterEphemeralPublicKey, observed: Date.now(), createdAt: event.created_at, id: event.id })
    if (invites.size > 256) { const first = invites.keys().next().value; if (first) invites.delete(first) }
  } catch { /* Invalid public invites cannot route wake-up bootstraps. */ }
}
const pending = new Map<string, {
  targets: Set<string>
  envelopes: Map<string, VerifiedEvent>
  until: number
  secretKey: Uint8Array
  serverUrl: string
  publish: (event: VerifiedEvent) => Promise<unknown>
  active: () => boolean
}>()

/** Device keys sign the routing envelope; only ratchet ciphertext goes inside. */
export function callWakeEvent(secretKey: Uint8Array, recipient: string, envelope: VerifiedEvent, bootstrap?: VerifiedEvent): VerifiedEvent {
  if (envelope.kind !== 1060 || !verifyEvent({ ...envelope }) ||
    envelope.tags.filter(tag => tag[0] === 'p').length !== 1 ||
    !envelope.tags.some(tag => tag[0] === 'p' && tag[1] === recipient)) throw new Error('Invalid call wake envelope')
  if (bootstrap && (bootstrap.kind !== 1059 || !verifyEvent({ ...bootstrap }) ||
    !bootstrap.tags.some(tag => tag[0] === 'p' && tag[1] === invites.get(recipient)?.ephemeral))) {
    throw new Error('Invalid call bootstrap')
  }
  const sign = (content: unknown) => finalizeEvent({ kind: CALL_WAKE_KIND, created_at: Math.floor(Date.now() / 1000),
    tags: [['p', recipient]], content: JSON.stringify(content) }, secretKey)
  let event = sign({ type: 'call-wake', v: 2, events: bootstrap ? [bootstrap, envelope] : [envelope] })
  if (bootstrap && new TextEncoder().encode(JSON.stringify(event)).length > 4096) {
    const stored = bootstraps.get(invites.get(recipient)?.ephemeral ?? '')
    if (!stored?.acknowledged || stored.event.id !== bootstrap.id) throw new Error('Call bootstrap has not reached a message server')
    event = sign({ type: 'call-wake', v: 2, events: [envelope], bootstrapEventId: bootstrap.id })
  }
  const bytes = new TextEncoder().encode(JSON.stringify(event)).length
  if (bytes > 4096) throw new Error(`Call wake envelope is too large (${bytes} bytes)`)
  return event
}

/** Called only after the normal ratchet outbox durably stores this exact ciphertext. */
export async function queuedCallWakeEnvelope(envelope: VerifiedEvent, innerEventId?: string): Promise<void> {
  if (envelope.kind === 1059 && verifyEvent({ ...envelope })) {
    const ephemeral = envelope.tags.find(tag => tag[0] === 'p')?.[1]
    if (ephemeral) {
      bootstraps.delete(ephemeral)
      bootstraps.set(ephemeral, { event: envelope, observed: Date.now(), acknowledged: false })
      if (bootstraps.size > 64) { const first = bootstraps.keys().next().value; if (first) bootstraps.delete(first) }
    }
    return
  }
  if (!innerEventId || envelope.kind !== 1060) return
  const item = pending.get(innerEventId)
  if (!item) return
  if (Date.now() >= item.until || !item.active()) { pending.delete(innerEventId); return }
  const recipient = envelope.tags.find(tag => tag[0] === 'p')?.[1]
  if (!recipient || !item.targets.has(recipient)) return
  item.envelopes.set(recipient, envelope)
  const invite = invites.get(recipient)
  const bootstrap = invite && Date.now() - invite.observed < 600_000 ? bootstraps.get(invite.ephemeral) : undefined
  const recentBootstrap = bootstrap && Date.now() - bootstrap.observed < WAKE_LIFETIME_MS ? bootstrap.event : undefined
  if (recentBootstrap && !bootstrap?.acknowledged) return
  const event = callWakeEvent(item.secretKey, recipient, envelope, recentBootstrap)
  item.targets.delete(recipient)
  if (!item.targets.size) pending.delete(innerEventId)
  await Promise.allSettled([
    item.publish(event),
    fetch(`${item.serverUrl.replace(/\/$/, '')}/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event), signal: AbortSignal.timeout(5000),
    }),
  ])
}

/** A reference wake cannot be delivered before the full authenticated bootstrap exists. */
export async function acceptedCallWakeBootstrap(event: VerifiedEvent): Promise<void> {
  if (event.kind !== 1059) return
  const ephemeral = event.tags.find(tag => tag[0] === 'p')?.[1]
  const entry = ephemeral && bootstraps.get(ephemeral)
  if (!entry || entry.event.id !== event.id) return
  entry.acknowledged = true
  for (const [inner, item] of pending) {
    for (const envelope of item.envelopes.values()) await queuedCallWakeEnvelope(envelope, inner)
  }
}

// FIPS carries the live call; the queued ratchet offer lets a sleeping peer recognize it.
export async function sendCallWakeups(secretKey: Uint8Array, owner: string, peers: string[], callId: string, video: boolean,
  serverUrl: string, publish: (event: VerifiedEvent) => Promise<unknown>,
  queue: (rumor: Rumor) => Promise<unknown>, active: () => boolean): Promise<void> {
  if (!validCallId(callId) || !/^[0-9a-f]{64}$/.test(owner) || !active()) return
  const targets = new Set(peers.map(peer => peer.slice(2)).filter(peer => /^[0-9a-f]{64}$/.test(peer)))
  if (!targets.size) return
  const now = Math.floor(Date.now() / 1000)
  const inner = { kind: CALL_WAKE_SIGNAL_KIND, pubkey: owner, created_at: now,
    tags: [['expiration', String(now + 40)]],
    content: JSON.stringify({ v: 3, type: 'offer', call_id: callId, video, muted: false, codec: CALL_CODEC }) }
  const rumor = { ...inner, id: getEventHash(inner) }
  pending.set(rumor.id, { targets, envelopes: new Map(), until: Date.now() + WAKE_LIFETIME_MS, secretKey: new Uint8Array(secretKey), serverUrl, publish, active })
  const timer = setTimeout(() => pending.delete(rumor.id), WAKE_LIFETIME_MS)
  try { await queue(rumor) }
  catch (error) { pending.delete(rumor.id); clearTimeout(timer); throw error }
}

import { AppKeys } from 'nostr-double-ratchet'
import { generateSecretKey, getEventHash, getPublicKey, verifyEvent, type Event, type UnsignedEvent, type VerifiedEvent } from 'nostr-tools'
import { signerRelayUrls, type SignerRuntime } from './remoteSigner'

const LOOKUP_TIMEOUT = 10_000
const MAX_EVENTS = 1024

function check(signal: AbortSignal) { signal.throwIfAborted() }

// Runtime relay/cache events are immutable; verifiers add their own cache symbol.
// Copy only signed fields so caller-owned verification flags cannot be trusted.
function canonicalEvent(event: Event): Event {
  return { id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind,
    tags: event.tags.map(tag => [...tag]), content: event.content, sig: event.sig }
}

export function selectSignerRoster(events: Event[], owner: string): VerifiedEvent | null {
  const candidates = new Map<string, VerifiedEvent>()
  let latest = 0
  for (const incoming of events) {
    if (incoming.pubkey !== owner || incoming.kind !== 37368 || !incoming.tags.some(tag => tag[0] === 'type' && tag[1] === 'app_keys_roster_snapshot')) continue
    const event = canonicalEvent(incoming)
    const appKeys = AppKeys.fromEvent(event as VerifiedEvent)
    if (event.created_at > Math.floor(Date.now() / 1000) + 300 || appKeys.getAllDevices().length > 64) throw new Error('Invalid device list from message server.')
    for (const tag of event.tags.filter(tag => tag[0] === 'device')) {
      if (!/^[a-f0-9]{64}$/.test(tag[1]) || !/^\d+$/.test(tag[2]) || !Number.isSafeInteger(Number(tag[2]))) throw new Error('Invalid device list from message server.')
    }
    if (event.created_at < latest) continue
    if (event.created_at > latest) { candidates.clear(); latest = event.created_at }
    candidates.set(event.id, event as VerifiedEvent)
  }
  if (candidates.size > 1) throw new Error('Conflicting device lists. Try again later.')
  return candidates.values().next().value ?? null
}

export async function fetchSignerRoster(owner: string, urls: string[], signal: AbortSignal, runtime: SignerRuntime): Promise<VerifiedEvent | null> {
  check(signal)
  const result = await runtime.query([{ kinds: [37368], authors: [owner], limit: MAX_EVENTS }], {
    relays: signerRelayUrls(urls), sources: [], cache: 'network-only', localEcho: false,
    // Concurrent signed roster heads must remain visible so conflict checks cannot
    // mistake the cache's deterministic replaceable winner for server consensus.
    includeSuperseded: true, deadline: Date.now() + LOOKUP_TIMEOUT, signal,
  })
  check(signal)
  if (!result.complete) throw new Error('Could not check all message servers. Try again.')
  if (result.events.length >= MAX_EVENTS) throw new Error('Device list is too large.')
  return selectSignerRoster(result.events, owner)
}

export function prepareSignerAuthorization(owner: string, device: string, previous: VerifiedEvent | null): UnsignedEvent {
  const now = Math.floor(Date.now() / 1000)
  const appKeys = previous ? AppKeys.fromEvent(canonicalEvent(previous) as VerifiedEvent) : new AppKeys()
  const createdAt = Math.max(now, (previous?.created_at ?? 0) + 1)
  if (createdAt > now + 300) throw new Error('Device list is dated too far ahead. Try again later.')
  appKeys.addDevice({ identityPubkey: device, createdAt: now })
  if (appKeys.getAllDevices().length > 64) throw new Error('Too many linked devices.')
  const event = appKeys.getEvent({ ownerPubkey: owner, createdAt })
  event.pubkey = owner
  // Retain public authorization only; old encrypted names remain in local state.
  if (JSON.stringify(event).length > 32 * 1024 - 256) throw new Error('Device list is too large.')
  return event
}

export function validateSignerAuthorization(expected: UnsignedEvent, incoming: Event): VerifiedEvent {
  const event = canonicalEvent(incoming)
  if (event.pubkey !== expected.pubkey || event.kind !== expected.kind || event.created_at !== expected.created_at || event.content !== expected.content || JSON.stringify(event.tags) !== JSON.stringify(expected.tags) || event.id !== getEventHash(expected)) throw new Error('Signer changed the device authorization. Try again.')
  if (!verifyEvent(event)) throw new Error('Invalid signer signature.')
  AppKeys.fromEvent(event as VerifiedEvent)
  return event as VerifiedEvent
}

export async function authorizeSignerDevice(options: {
  owner: string
  runtime: SignerRuntime
  relays: string[]
  signal: AbortSignal
  signEvent: (event: UnsignedEvent) => Promise<Event>
  onCommitting?: () => void
}): Promise<{ event: VerifiedEvent; deviceSecret: Uint8Array }> {
  const { owner, relays, signal, runtime } = options
  const deviceSecret = generateSecretKey()
  try {
    const previous = await fetchSignerRoster(owner, relays, signal, runtime)
    const expected = prepareSignerAuthorization(owner, getPublicKey(deviceSecret), previous)
    const event = validateSignerAuthorization(expected, await options.signEvent(expected))
    check(signal)
    const current = await fetchSignerRoster(owner, relays, signal, runtime)
    if (current?.id !== previous?.id) throw new Error('Your device list changed. Sign in again.')
    check(signal)
    // Once servers may accept this authorization, retain its device key and
    // finish local installation. Cancelling here would strand an approved key.
    options.onCommitting?.()
    const receipt = await runtime.publish(event, { relays: signerRelayUrls(relays), sources: [], requireAck: true, queue: false, localEcho: false })
    if (!receipt.remoteAccepted) throw new Error('Could not save device authorization. Try again.')
    return { event, deviceSecret }
  } catch (error) {
    deviceSecret.fill(0)
    throw error
  }
}

import { AppKeys } from 'nostr-double-ratchet'
import { generateSecretKey, getEventHash, getPublicKey, verifyEvent, type Event, type UnsignedEvent, type VerifiedEvent } from 'nostr-tools'
import { Relay } from 'nostr-tools/relay'
import { signerRelayUrls } from './remoteSigner'

const LOOKUP_TIMEOUT = 10_000
const MAX_EVENTS = 1024

function check(signal: AbortSignal) { signal.throwIfAborted() }

export function selectSignerRoster(events: Event[], owner: string): VerifiedEvent | null {
  const candidates = new Map<string, VerifiedEvent>()
  let latest = 0
  for (const event of events) {
    if (event.pubkey !== owner || event.kind !== 37368 || !event.tags.some(tag => tag[0] === 'type' && tag[1] === 'app_keys_roster_snapshot')) continue
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

export async function fetchSignerRoster(owner: string, urls: string[], signal: AbortSignal): Promise<VerifiedEvent | null> {
  check(signal)
  const results = await Promise.all(signerRelayUrls(urls).map(async url => {
    const relay = new Relay(url)
    try {
      await relay.connect({ timeout: LOOKUP_TIMEOUT, abort: signal })
      check(signal)
      return await new Promise<Event[]>((resolve, reject) => {
        const events: Event[] = []
        let settled = false
        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          subscription.close()
          if (error) reject(error); else resolve(events)
        }
        const abort = () => finish(new Error('Sign-in cancelled.'))
        const timer = setTimeout(() => finish(new Error('Could not check all message servers. Try again.')), LOOKUP_TIMEOUT)
        const subscription = relay.subscribe([{ kinds: [37368], authors: [owner], limit: MAX_EVENTS }], {
          // The library synthesizes EOSE at its deadline. Our earlier deadline
          // must reject, so an incomplete response can never erase old devices.
          eoseTimeout: LOOKUP_TIMEOUT + 1000,
          onevent: event => {
            events.push(event)
            if (events.length >= MAX_EVENTS) finish(new Error('Device list is too large.'))
          },
          oneose: () => finish(),
          oninvalidevent: () => finish(new Error('Invalid device list from message server.')),
          onclose: () => finish(new Error('Could not check all message servers. Try again.')),
        })
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    } finally { relay.close() }
  }))
  check(signal)
  return selectSignerRoster(results.flat(), owner)
}

export function prepareSignerAuthorization(owner: string, device: string, previous: VerifiedEvent | null): UnsignedEvent {
  const now = Math.floor(Date.now() / 1000)
  const appKeys = previous ? AppKeys.fromEvent(previous) : new AppKeys()
  const createdAt = Math.max(now, (previous?.created_at ?? 0) + 1)
  if (createdAt > now + 300) throw new Error('Device list is dated too far ahead. Try again later.')
  appKeys.addDevice({ identityPubkey: device, createdAt: now })
  if (appKeys.getAllDevices().length > 64) throw new Error('Too many linked devices.')
  const event = appKeys.getEvent({ ownerPubkey: owner, createdAt })
  event.pubkey = owner
  event.tags.push(...(previous?.tags.filter(tag => tag[0] === 'encrypted_device_labels').map(tag => [...tag]) ?? []))
  if (JSON.stringify(event).length > 32 * 1024 - 256) throw new Error('Device list is too large.')
  return event
}

export function validateSignerAuthorization(expected: UnsignedEvent, event: Event): VerifiedEvent {
  if (event.pubkey !== expected.pubkey || event.kind !== expected.kind || event.created_at !== expected.created_at || event.content !== expected.content || JSON.stringify(event.tags) !== JSON.stringify(expected.tags) || event.id !== getEventHash(expected)) throw new Error('Signer changed the device authorization. Try again.')
  if (!verifyEvent(event)) throw new Error('Invalid signer signature.')
  AppKeys.fromEvent(event as VerifiedEvent)
  return event as VerifiedEvent
}

export async function authorizeSignerDevice(options: {
  owner: string
  relays: string[]
  signal: AbortSignal
  signEvent: (event: UnsignedEvent) => Promise<Event>
  onCommitting?: () => void
}): Promise<{ event: VerifiedEvent; deviceSecret: Uint8Array }> {
  const { owner, relays, signal } = options
  const deviceSecret = generateSecretKey()
  try {
    const previous = await fetchSignerRoster(owner, relays, signal)
    const expected = prepareSignerAuthorization(owner, getPublicKey(deviceSecret), previous)
    const event = validateSignerAuthorization(expected, await options.signEvent(expected))
    check(signal)
    const current = await fetchSignerRoster(owner, relays, signal)
    if (current?.id !== previous?.id) throw new Error('Your device list changed. Sign in again.')
    check(signal)
    // Once servers may accept this authorization, retain its device key and
    // finish local installation. Cancelling here would strand an approved key.
    options.onCommitting?.()
    const commitSignal = new AbortController().signal
    await Promise.any(signerRelayUrls(relays).map(async url => {
      const relay = new Relay(url)
      try {
        await relay.connect({ timeout: LOOKUP_TIMEOUT, abort: commitSignal })
        relay.publishTimeout = LOOKUP_TIMEOUT
        await relay.publish(event)
      } finally { relay.close() }
    })).catch(() => { throw new Error('Could not save device authorization. Try again.') })
    return { event, deviceSecret }
  } catch (error) {
    deviceSecret.fill(0)
    throw error
  }
}

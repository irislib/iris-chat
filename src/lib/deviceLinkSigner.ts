import { AppKeys } from 'nostr-double-ratchet'
import { finalizeEvent, generateSecretKey, getPublicKey, nip44, verifyEvent, type Event, type EventTemplate, type UnsignedEvent, type VerifiedEvent } from 'nostr-tools'
import { fetchSignerRoster, validateSignerAuthorization } from './signerAuthorization'
import { signerRelayUrls, type SignerRuntime } from './remoteSigner'
import type { DeviceHistoryChoice } from './deviceHistoryPolicy'

const pubkey = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
export function parseDeviceConnectLink(input: string) {
  const url = new URL(input.trim().replace(/^nostr:/, ''))
  if (url.protocol !== 'nostrconnect:' || !pubkey(url.hostname) || (url.pathname && url.pathname !== '/') || url.username || url.password || url.port || url.hash) throw new Error('Invalid device link.')
  const secret = url.searchParams.get('secret')
  const permissions = url.searchParams.get('perms')
  if (!secret || secret.length > 256 || (permissions && permissions !== 'sign_event:37368')) throw new Error('This link requests unsupported permissions.')
  return { client: url.hostname, secret, relays: signerRelayUrls(url.searchParams.getAll('relay')) }
}

export function validateDeviceAddition(draft: UnsignedEvent, owner: string, previous: VerifiedEvent | null, now = Math.floor(Date.now() / 1000)) {
  if (draft && !draft.pubkey) draft = { ...draft, pubkey: owner }
  if (!draft || draft.kind !== 37368 || draft.pubkey !== owner || draft.content !== '' || !Number.isSafeInteger(draft.created_at) || draft.created_at <= (previous?.created_at ?? 0) || draft.created_at > now + 300 || draft.created_at < now - 120 || !Array.isArray(draft.tags)) throw new Error('Invalid device authorization.')
  const old = previous ? AppKeys.fromEvent(previous) : new AppKeys()
  const deviceTags = draft.tags.filter(tag => tag[0] === 'device')
  if (deviceTags.length !== old.getAllDevices().length + 1 || deviceTags.length > 64) throw new Error('Only one new device can be linked.')
  const additions = deviceTags.filter(tag => !old.getAllDevices().some(device => device.identityPubkey === tag[1]))
  if (additions.length !== 1 || !pubkey(additions[0][1]) || !/^\d+$/.test(additions[0][2] ?? '')) throw new Error('Invalid new device.')
  const device = additions[0][1], linkAt = Number(additions[0][2])
  if (!Number.isSafeInteger(linkAt) || linkAt < now - 120 || linkAt > now + 300) throw new Error('This device link has expired. Create a new one.')
  const profile = draft.tags.find(tag => tag[0] === 'd')?.[1]
  if (!profile || profile.length > 128) throw new Error('Invalid device authorization.')
  old.addDevice({ identityPubkey: device, createdAt: linkAt })
  const expected = old.getEvent({ ownerPubkey: owner, profileId: profile, createdAt: draft.created_at })
  expected.pubkey = owner
  if (JSON.stringify(expected.tags) !== JSON.stringify(draft.tags)) throw new Error('The request changed existing devices.')
  return { expected, device, linkAt }
}

/** A two-minute, single-device NIP-46 approval using the existing message worker. */
export async function serveDeviceLink(options: {
  link: string
  owner: string
  approver: string
  runtime: SignerRuntime
  signal: AbortSignal
  sign(event: EventTemplate): Promise<Event>
  savePair(device: string, linkAt: number, linkId: string): Promise<void>
  timeoutMs?: number
}): Promise<void> {
  const link = parseDeviceConnectLink(options.link)
  const secret = generateSecretKey(), local = getPublicKey(secret)
  const conversation = nip44.v2.utils.getConversationKey(secret, link.client)
  let signed: Event | undefined
  let info: { v: 1; device: string; approver: string; linkAt: number; linkId: string } | undefined
  let done = false, queued = Promise.resolve(), requests = 0
  const seen = new Set<string>()
  let resolve!: () => void, reject!: (error: Error) => void
  const finished = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  const fail = (error: Error) => { if (!done) { done = true; reject(error) } }
  const active = () => { if (done || options.signal.aborted) throw new Error('Device linking cancelled.') }
  const abort = () => fail(new Error('Device linking cancelled.'))
  const timer = setTimeout(() => fail(new Error('This device link has expired. Create a new one.')), options.timeoutMs ?? 120_000)
  const send = async (id: string, result: string, error?: string) => {
    if (done || options.signal.aborted) throw new Error('Device linking cancelled.')
    const event = finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [['p', link.client]],
      content: nip44.v2.encrypt(JSON.stringify({ id, result, ...(error && { error }) }), conversation) }, secret)
    const receipt = await options.runtime.publish(event, { relays: link.relays, sources: [], requireAck: true, queue: false, localEcho: false })
    if (!receipt.remoteAccepted) throw new Error('Could not reach the new device. Try again.')
  }
  options.signal.addEventListener('abort', abort, { once: true })
  const subscription = options.runtime.subscribe([{ kinds: [24133], authors: [link.client], '#p': [local], since: Math.floor(Date.now() / 1000) - 60 }], {
    onEvent: raw => {
      if (done || raw.content.length > 64 * 1024 || seen.has(raw.id) || raw.pubkey !== link.client || raw.kind !== 24133 || !raw.tags.some(tag => tag[0] === 'p' && tag[1] === local)) return
      const event = { id: raw.id, pubkey: raw.pubkey, sig: raw.sig, kind: raw.kind, created_at: raw.created_at, content: raw.content, tags: raw.tags.map(tag => [...tag]) }
      if (!verifyEvent(event)) return
      let request: { id: string; method: string; params: string[] }
      try { request = JSON.parse(nip44.v2.decrypt(event.content, conversation)) } catch { return }
      if (typeof request.id !== 'string' || request.id.length > 128 || typeof request.method !== 'string' || !Array.isArray(request.params) || !request.params.every(value => typeof value === 'string')) return
      if (++requests > 64) { fail(new Error('Too many device-link requests.')); return }
      seen.add(raw.id)
      queued = queued.then(async () => {
        if (done) return
        try {
          if (request.method === 'switch_relays') await send(request.id, JSON.stringify(link.relays))
          else if (request.method === 'get_public_key') await send(request.id, options.owner)
          else if (request.method === 'sign_event' && request.params.length === 1) {
            const requested = JSON.parse(request.params[0]) as UnsignedEvent
            const draft = { ...requested, pubkey: requested.pubkey ?? options.owner }
            if (signed) {
              validateSignerAuthorization(draft, signed)
            } else {
              const previous = await fetchSignerRoster(options.owner, link.relays, options.signal, options.runtime)
              active()
              const addition = validateDeviceAddition(draft, options.owner, previous)
              if (!previous || !AppKeys.fromEvent(previous).getAllDevices().some(device => device.identityPubkey === options.approver)) throw new Error('This device is no longer authorized to link devices.')
              const candidate = validateSignerAuthorization(addition.expected, await options.sign(addition.expected))
              active()
              const latest = await fetchSignerRoster(options.owner, link.relays, options.signal, options.runtime)
              active()
              if (latest?.id !== previous.id) throw new Error('Your device list changed. Create a new link.')
              await options.savePair(addition.device, addition.linkAt, link.client)
              signed = candidate
              info = { v: 1, linkId: link.client, approver: options.approver, device: addition.device, linkAt: addition.linkAt }
            }
            await send(request.id, JSON.stringify(signed))
          } else if (request.method === 'iris_get_link_info' && info) {
            await send(request.id, JSON.stringify(info))
            done = true; resolve()
          } else await send(request.id, '', 'Unsupported method')
        } catch (error) {
          if (done || options.signal.aborted) return
          await send(request.id, '', error instanceof Error ? error.message : 'Could not link device.')
          fail(error instanceof Error ? error : new Error('Could not link device.'))
        }
      }).catch(error => fail(error instanceof Error ? error : new Error('Could not link device.')))
    },
  }, { relays: link.relays, sources: [], cache: 'network-only', localEcho: false, signal: options.signal })
  try {
    if (options.signal.aborted) abort()
    else await send(crypto.randomUUID(), link.secret)
    await finished
  } finally {
    done = true
    subscription.close(); clearTimeout(timer); options.signal.removeEventListener('abort', abort); secret.fill(0)
  }
}

export async function approveDeviceConnectLink(link: string, choice: DeviceHistoryChoice, signal: AbortSignal): Promise<void> {
  const { get } = await import('svelte/store')
  const { identity, nostrClient } = await import('./identity')
  const { ensureDeviceRegistered, getNdrRuntime } = await import('./privateChats')
  const { saveDeviceHistoryPair } = await import('./deviceHistoryPolicy')
  const account = get(identity)
  if (!account?.signer || account.isLinkedDevice) throw new Error('Use your main device to approve this link.')
  await ensureDeviceRegistered()
  const approver = getNdrRuntime().getState().currentDevicePubkey
  if (!approver) throw new Error('This device is not ready.')
  return serveDeviceLink({ link, owner: account.pubkey, approver, runtime: get(nostrClient).runtime, signal,
    sign: event => {
      if (get(identity)?.pubkey !== account.pubkey) throw new Error('Account changed.')
      return account.signer!.signEvent(event)
    },
    savePair: (peer, linkAt, linkId) => saveDeviceHistoryPair(account.pubkey, approver, { peer, linkAt, linkId,
      since: choice === 'history' ? 0 : linkAt, role: 'outbound', complete: choice === 'chats' }),
  })
}

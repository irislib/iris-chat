import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { NostrRuntime } from 'nostr-pubsub'
import { openPeerAnnouncementStore } from './peerAnnouncementStore'

it('restores targeted discovery privately and only replays our own announcement', async () => {
  const own = generateSecretKey(), other = generateSecretKey()
  const owner = getPublicKey(generateSecretKey()), device = getPublicKey(own), target = getPublicKey(other)
  const runtime = new NostrRuntime({ relays: [] })
  const now = Math.floor(Date.now() / 1000)
  const advert = (key: Uint8Array) => finalizeEvent({ kind: 37195, created_at: now, content: '{}',
    tags: [['d', 'private-fixture'], ['expiration', String(now + 600)]] }, key)
  const ours = advert(own), theirs = advert(other)
  let cache = await openPeerAnnouncementStore(owner, device, 'private-fixture', runtime)
  try {
    await cache.discovery.publish(ours)
    await cache.discovery.publish(theirs)
    await cache.close()
    cache = await openPeerAnnouncementStore(owner, device, 'private-fixture', runtime)
    const restored: string[] = []
    await cache.discovery.subscribe({ kinds: [37195], authors: [target] }, event => restored.push(event.id))
    expect(restored).toEqual([theirs.id])
    expect((await cache.publicReader.query([{ kinds: [37195] }])).events.map(item => item.event.id)).toEqual([ours.id])
    expect((await cache.publicReader.query([{ kinds: [37195], authors: [target] }])).events).toEqual([])
    const isolated = await openPeerAnnouncementStore(getPublicKey(generateSecretKey()), device, 'private-fixture', runtime)
    try { expect((await isolated.publicReader.query([{}])).events).toEqual([]) } finally { await isolated.close() }
  } finally { await cache.close(); await runtime.close() }
})

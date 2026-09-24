import { afterEach, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, nip44, verifyEvent } from 'nostr-tools'
import { callWakeEvent, sendCallWakeups } from './callPush'

afterEach(() => vi.unstubAllGlobals())
it('signs an encrypted device-bound offer compatible with the native wakeup', () => {
  const sender = generateSecretKey(), recipient = generateSecretKey()
  const event = callWakeEvent(sender, getPublicKey(recipient), '12'.repeat(16), true)
  expect(verifyEvent(event)).toBe(true)
  expect(event.kind).toBe(21111)
  expect(event.tags).toEqual([['p', getPublicKey(recipient)]])
  const content = nip44.v2.decrypt(event.content, nip44.v2.utils.getConversationKey(recipient, getPublicKey(sender)))
  expect(JSON.parse(content)).toEqual({ v: 3, type: 'offer', call_id: '12'.repeat(16), video: true, muted: false, codec: 'opus-h264-v3' })
})
it('uses the existing service and deduplicates device identities', async () => {
  const fetch = vi.fn(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetch)
  const publish = vi.fn(async () => {})
  const sender = generateSecretKey(), target = getPublicKey(generateSecretKey())
  await sendCallWakeups(sender, [`02${target}`, `03${target}`], '34'.repeat(16), false, 'https://push.example/', publish)
  expect(publish).toHaveBeenCalledTimes(1)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch).toHaveBeenCalledWith('https://push.example/events', expect.objectContaining({ method: 'POST', body: JSON.stringify(publish.mock.calls[0][0]) }))
})

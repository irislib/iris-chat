import { expect, it, vi } from 'vitest'
import type { NostrFilter, NostrRuntime, RuntimeCompletion, RuntimeSubscriptionHandlers } from 'nostr-pubsub/private-relays'
import { privateDiscoverySubscribe, splitPrivateDiscoveryFilters } from './privateDiscoveryRouting'

const alice = 'a'.repeat(64), bob = 'b'.repeat(64), device = 'c'.repeat(64)

it('splits public invite and authorization discovery from private receiving interests', () => {
  const receive = { kinds: [1060], authors: ['d'.repeat(64)] }
  const result = splitPrivateDiscoveryFilters([
    receive,
    { kinds: [37368], authors: [alice, bob] },
    { kinds: [30078], authors: [bob], '#l': ['double-ratchet/invites'] },
    { kinds: [37368], '#p': [device] },
    { kinds: [0, 10002, 10050], authors: [alice, bob] },
    { kinds: [0, 10013], authors: [alice] },
    { kinds: [0], search: 'public directory', limit: 10 },
  ])
  expect(result.receiver).toEqual([receive, { kinds: [10013], authors: [alice] },
    { kinds: [0], search: 'public directory', limit: 10 }])
  expect(result.discovery).toEqual([
    [{ kinds: [37368], authors: [alice] }, { kinds: [0, 10002, 10050], authors: [alice] },
      { kinds: [0], authors: [alice] }],
    [{ kinds: [37368], authors: [bob] }, { kinds: [30078], authors: [bob], '#l': ['double-ratchet/invites'] },
      { kinds: [0, 10002, 10050], authors: [bob] }],
    [{ kinds: [37368], '#p': [device] }],
  ])
  for (const filter of [
    { kinds: [37368] },
    { kinds: [37368], authors: [alice], '#p': [bob] },
    { kinds: [30078], '#p': [device] },
    { kinds: [37368], authors: ['invalid'] },
    { kinds: [37368], authors: [alice], '#type': ['group_roster'] },
  ]) expect(() => splitPrivateDiscoveryFilters([filter])).toThrow()
})

it('keeps partial discovery incomplete and closes every scoped subscription', () => {
  const opened: Array<{ handlers: RuntimeSubscriptionHandlers; close: ReturnType<typeof vi.fn> }> = []
  const subscribe = vi.fn<NostrRuntime['subscribe']>((_filters: NostrFilter[], handlers: RuntimeSubscriptionHandlers) => {
    const close = vi.fn()
    opened.push({ handlers, close })
    return { close }
  })
  const onEose = vi.fn(), onError = vi.fn()
  const sub = privateDiscoverySubscribe(subscribe, subscribe)([
    { kinds: [1059], '#p': [device] }, { kinds: [37368], authors: [alice, bob] },
  ], { onEvent: vi.fn(), onEose, onError })
  const ready: RuntimeCompletion = { complete: true, reason: 'eose', sources: [{ id: 'wss://test', complete: true }] }
  opened[0].handlers.onEose?.(ready)
  opened[1].handlers.onEose?.(ready)
  expect(onEose).not.toHaveBeenCalled()
  opened[2].handlers.onEose?.({ complete: false, reason: 'timeout', sources: [{ id: 'wss://test', complete: false, error: 'timed out' }] })
  expect(onEose).toHaveBeenCalledWith({ complete: false, reason: 'timeout', sources: [{ id: 'wss://test', complete: false, error: 'timed out' }] })
  sub.close()
  expect(opened.every(entry => entry.close.mock.calls.length === 1)).toBe(true)
  opened[2].handlers.onError?.(new Error('closed'))
  expect(onError).not.toHaveBeenCalled()
})

import { expect, it, vi } from 'vitest'
import type { NostrFilter, NostrRuntime, RuntimeCompletion, RuntimeSubscribeOptions, RuntimeSubscriptionHandlers } from 'nostr-pubsub/private-relays'
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
  // An author batch stays one lookup instead of one request per author.
  expect(result.discovery).toEqual([
    { kinds: [37368], authors: [alice, bob] },
    { kinds: [0, 10002, 10050], authors: [alice, bob] },
    { kinds: [0], authors: [alice] },
    { kinds: [30078], authors: [bob], '#l': ['double-ratchet/invites'] },
    { kinds: [37368], '#p': [device] },
  ])
  for (const filter of [
    { kinds: [37368] },
    { kinds: [37368], authors: [alice], '#p': [bob] },
    { kinds: [30078], '#p': [device] },
    { kinds: [37368], authors: ['invalid'] },
    { kinds: [37368], authors: [alice], '#type': ['group_roster'] },
  ]) expect(() => splitPrivateDiscoveryFilters([filter])).toThrow()
})

const recorder = () => {
  const opened: Array<{ filters: NostrFilter[]; handlers: RuntimeSubscriptionHandlers; options?: RuntimeSubscribeOptions; close: ReturnType<typeof vi.fn> }> = []
  const subscribe = vi.fn<NostrRuntime['subscribe']>((filters: NostrFilter[], handlers: RuntimeSubscriptionHandlers, options?: RuntimeSubscribeOptions) => {
    const close = vi.fn()
    opened.push({ filters, handlers, options, close })
    return { close }
  })
  return { opened, subscribe }
}

it('keeps partial discovery incomplete, off peer sources, and closes every subscription', () => {
  const { opened, subscribe } = recorder()
  const onEose = vi.fn(), onError = vi.fn()
  const sub = privateDiscoverySubscribe(subscribe)([
    { kinds: [1059], '#p': [device] }, { kinds: [37368], authors: [alice, bob] },
    { kinds: [0, 10002], authors: [alice, bob] },
  ], { onEvent: vi.fn(), onEose, onError }, { sources: ['fips'], cache: 'cache-first' })
  // Receiving interests keep their sources; lookups go only to the account's relays.
  expect(opened.map(entry => [entry.filters, entry.options])).toEqual([
    [[{ kinds: [1059], '#p': [device] }], { sources: ['fips'], cache: 'cache-first' }],
    [[{ kinds: [37368], authors: [alice, bob] }, { kinds: [0, 10002], authors: [alice, bob] }], { sources: [], cache: 'cache-first' }],
  ])
  const ready: RuntimeCompletion = { complete: true, reason: 'eose', sources: [{ id: 'wss://test', complete: true }] }
  opened[0].handlers.onEose?.(ready)
  expect(onEose).not.toHaveBeenCalled()
  opened[1].handlers.onEose?.({ complete: false, reason: 'timeout', sources: [{ id: 'wss://test', complete: false, error: 'timed out' }] })
  expect(onEose).toHaveBeenCalledWith({ complete: false, reason: 'timeout', sources: [{ id: 'wss://test', complete: false, error: 'timed out' }] })
  sub.close()
  expect(opened.every(entry => entry.close.mock.calls.length === 1)).toBe(true)
  opened[1].handlers.onError?.(new Error('closed'))
  expect(onError).not.toHaveBeenCalled()
})

it('sends a lookup alone straight through and keeps large author batches inside request bounds', () => {
  const single = recorder()
  privateDiscoverySubscribe(single.subscribe)([{ kinds: [30078], authors: [bob], '#l': ['double-ratchet/invites'] }],
    { onEvent: vi.fn() }, { sources: ['fips'] })
  expect(single.opened.map(entry => [entry.filters, entry.options])).toEqual([
    [[{ kinds: [30078], authors: [bob], '#l': ['double-ratchet/invites'] }], { sources: [] }],
  ])
  const authors = Array.from({ length: 600 }, (_, index) => index.toString(16).padStart(64, '0'))
  const many = recorder()
  privateDiscoverySubscribe(many.subscribe)([{ kinds: [0, 10002, 10050], authors }], { onEvent: vi.fn() })
  expect(many.opened.length).toBeGreaterThan(1)
  for (const { filters, options } of many.opened) {
    expect(options).toEqual({ sources: [] })
    expect(filters.length).toBeLessThanOrEqual(20)
    expect(JSON.stringify(filters).length).toBeLessThan(32_768)
    for (const filter of filters) expect(filter.authors!.length).toBeLessThanOrEqual(256)
  }
  expect(many.opened.flatMap(entry => entry.filters.flatMap(filter => filter.authors ?? []))).toEqual(authors)
})

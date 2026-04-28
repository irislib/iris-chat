import { describe, expect, it, vi } from 'vitest'

import {
  getPublishedRelayUrls,
  publishRuntimeEventFireAndForget,
  type RuntimePublishResult,
} from './privateChats'

describe('runtime publish', () => {
  it('returns the event without waiting for relay acknowledgement', () => {
    let publishResolved = false
    const event = { id: 'event-id' }
    const publish = vi.fn(
      () =>
        new Promise<{ size: number }>((resolve) => {
          setTimeout(() => {
            publishResolved = true
            resolve({ size: 1 })
          }, 10)
        })
    )

    const result = publishRuntimeEventFireAndForget(event, publish)

    expect(result).toBe(event)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publishResolved).toBe(false)
  })

  it('extracts accepted relay URLs from NDK publish results', () => {
    const publishedRelays = new Set([
      { url: 'wss://relay.one' },
      { relay: { url: 'wss://relay.two' } },
      { url: 'wss://relay.one' },
    ])

    expect(getPublishedRelayUrls(publishedRelays)).toEqual([
      'wss://relay.one',
      'wss://relay.two',
    ])
  })

  it('reports accepted relay URLs after relay acknowledgement', async () => {
    const event = { id: 'event-id' }
    const acceptedRelays = new Set([
      { url: 'wss://relay.one' },
      { url: 'wss://relay.two' },
    ])
    const publish = vi.fn(async () => acceptedRelays as RuntimePublishResult)
    const onAcceptedRelays = vi.fn()

    const result = publishRuntimeEventFireAndForget(event, publish, onAcceptedRelays)

    expect(result).toBe(event)
    expect(onAcceptedRelays).not.toHaveBeenCalled()

    await Promise.resolve()
    await Promise.resolve()

    expect(onAcceptedRelays).toHaveBeenCalledTimes(1)
    expect(onAcceptedRelays).toHaveBeenCalledWith([
      'wss://relay.one',
      'wss://relay.two',
    ])
  })
})

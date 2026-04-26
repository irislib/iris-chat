import { describe, expect, it, vi } from 'vitest'

import { publishRuntimeEventFireAndForget } from './privateChats'

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
})

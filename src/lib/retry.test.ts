import { describe, expect, it, vi } from 'vitest'
import { retryAsync } from './retry'

describe('retryAsync', () => {
  it('returns on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await retryAsync(fn, [1, 1, 1])
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries until success', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockResolvedValue('ok')

    const result = await retryAsync(fn, [0, 0, 0])
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('throws after exhausting retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('nope'))
    await expect(retryAsync(fn, [0, 0])).rejects.toThrow('nope')
    expect(fn).toHaveBeenCalledTimes(3)
  })
})

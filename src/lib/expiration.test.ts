import { describe, it, expect, vi, afterEach } from 'vitest'
import { EXPIRATION_OPTIONS, getExpirationLabel, formatExpirationTime } from './expiration'

describe('EXPIRATION_OPTIONS', () => {
  it('contains the expected set of options', () => {
    expect(EXPIRATION_OPTIONS.length).toBe(6)
    expect(EXPIRATION_OPTIONS[0]).toEqual({ label: '5 minutes', value: 300 })
    expect(EXPIRATION_OPTIONS[5]).toEqual({ label: '3 months', value: 90 * 24 * 60 * 60 })
  })

  it('all values are positive integers in ascending order', () => {
    for (let i = 0; i < EXPIRATION_OPTIONS.length; i++) {
      expect(EXPIRATION_OPTIONS[i].value).toBeGreaterThan(0)
      expect(Number.isInteger(EXPIRATION_OPTIONS[i].value)).toBe(true)
      if (i > 0) {
        expect(EXPIRATION_OPTIONS[i].value).toBeGreaterThan(EXPIRATION_OPTIONS[i - 1].value)
      }
    }
  })
})

describe('getExpirationLabel', () => {
  it('returns exact label for known options', () => {
    expect(getExpirationLabel(300)).toBe('5 minutes')
    expect(getExpirationLabel(3600)).toBe('1 hour')
    expect(getExpirationLabel(86400)).toBe('24 hours')
    expect(getExpirationLabel(604800)).toBe('1 week')
  })

  it('returns seconds for values under a minute', () => {
    expect(getExpirationLabel(30)).toBe('30 seconds')
    expect(getExpirationLabel(1)).toBe('1 seconds')
  })

  it('returns minutes for values under an hour', () => {
    expect(getExpirationLabel(120)).toBe('2 minutes')
    expect(getExpirationLabel(600)).toBe('10 minutes')
  })

  it('returns hours for values under a day', () => {
    expect(getExpirationLabel(7200)).toBe('2 hours')
    expect(getExpirationLabel(43200)).toBe('12 hours')
  })

  it('returns days for large values', () => {
    expect(getExpirationLabel(172800)).toBe('2 days')
    expect(getExpirationLabel(259200)).toBe('3 days')
  })
})

describe('formatExpirationTime', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns "Expired" for timestamps in the past', () => {
    const past = Math.floor(Date.now() / 1000) - 10
    expect(formatExpirationTime(past)).toBe('Expired')
  })

  it('returns "Expired" for current timestamp', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(formatExpirationTime(now)).toBe('Expired')
  })

  it('returns seconds format for less than a minute remaining', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(formatExpirationTime(now + 30)).toBe('30s')
    expect(formatExpirationTime(now + 1)).toBe('1s')
  })

  it('returns minutes format for less than an hour remaining', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(formatExpirationTime(now + 300)).toBe('5m')
    expect(formatExpirationTime(now + 3599)).toBe('59m')
  })

  it('returns hours format for less than 1.5 days remaining', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(formatExpirationTime(now + 3600)).toBe('1h')
    expect(formatExpirationTime(now + 7200)).toBe('2h')
  })

  it('returns days format for multi-day periods', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(formatExpirationTime(now + 2 * 86400)).toBe('2d')
    expect(formatExpirationTime(now + 5 * 86400)).toBe('5d')
  })

  it('returns weeks format for multi-week periods', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(formatExpirationTime(now + 14 * 86400)).toBe('2w')
  })

  it('returns months format for very long periods', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(formatExpirationTime(now + 90 * 86400)).toBe('3mo')
  })
})

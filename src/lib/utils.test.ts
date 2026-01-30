import { describe, it, expect } from 'vitest'
import { formatDayLabel, isDifferentDay, getErrorMessage } from './utils'

describe('formatDayLabel', () => {
  const now = new Date('2025-01-30T12:00:00')

  it('should return "Today" for current day', () => {
    const timestamp = new Date('2025-01-30T08:30:00').getTime()
    expect(formatDayLabel(timestamp, now)).toBe('Today')
  })

  it('should return "Yesterday" for previous day', () => {
    const timestamp = new Date('2025-01-29T20:00:00').getTime()
    expect(formatDayLabel(timestamp, now)).toBe('Yesterday')
  })

  it('should return weekday name for 2-6 days ago', () => {
    const timestamp = new Date('2025-01-27T12:00:00').getTime() // Monday
    const result = formatDayLabel(timestamp, now)
    expect(result).toBe('Monday')
  })

  it('should return short date for 7+ days ago in same year', () => {
    const timestamp = new Date('2025-01-10T12:00:00').getTime()
    const result = formatDayLabel(timestamp, now)
    expect(result).toMatch(/Jan/)
    expect(result).toMatch(/10/)
    expect(result).not.toMatch(/2025/)
  })

  it('should include year for different year', () => {
    const timestamp = new Date('2024-12-25T12:00:00').getTime()
    const result = formatDayLabel(timestamp, now)
    expect(result).toMatch(/Dec/)
    expect(result).toMatch(/25/)
    expect(result).toMatch(/2024/)
  })
})

describe('isDifferentDay', () => {
  it('should return false for same day', () => {
    const a = new Date('2025-01-30T08:00:00').getTime()
    const b = new Date('2025-01-30T23:59:59').getTime()
    expect(isDifferentDay(a, b)).toBe(false)
  })

  it('should return true for different days', () => {
    const a = new Date('2025-01-30T23:59:59').getTime()
    const b = new Date('2025-01-31T00:00:00').getTime()
    expect(isDifferentDay(a, b)).toBe(true)
  })

  it('should return true for different months', () => {
    const a = new Date('2025-01-30T12:00:00').getTime()
    const b = new Date('2025-02-01T12:00:00').getTime()
    expect(isDifferentDay(a, b)).toBe(true)
  })

  it('should return true for different years', () => {
    const a = new Date('2024-12-31T23:59:59').getTime()
    const b = new Date('2025-01-01T00:00:00').getTime()
    expect(isDifferentDay(a, b)).toBe(true)
  })
})

describe('getErrorMessage', () => {
  it('should return error message for Error instances', () => {
    expect(getErrorMessage(new Error('test'), 'fallback')).toBe('test')
  })

  it('should return fallback for non-Error values', () => {
    expect(getErrorMessage('string', 'fallback')).toBe('fallback')
    expect(getErrorMessage(42, 'fallback')).toBe('fallback')
    expect(getErrorMessage(null, 'fallback')).toBe('fallback')
  })
})

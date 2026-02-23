import { getExpirationLabel } from './expiration'

export function normalizeDisappearingTtl(ttlSeconds: number | null | undefined): number | null {
  if (typeof ttlSeconds !== 'number' || ttlSeconds <= 0) return null
  return Math.floor(ttlSeconds)
}

export function buildDisappearingNotice(ttlSeconds: number | null | undefined): string {
  const normalized = normalizeDisappearingTtl(ttlSeconds)
  if (normalized === null) return 'Disappearing messages turned off'
  return `Disappearing messages set to ${getExpirationLabel(normalized)}`
}

import { nip19 } from 'nostr-tools'
import type { Profile } from './profile'

export function mergePeopleProfiles(...sources: Map<string, Profile>[]): Map<string, Profile> {
  const profiles = new Map<string, Profile>()
  for (const source of sources) for (const [key, profile] of source) {
    if ((profile.eventCreatedAt ?? -1) >= (profiles.get(key)?.eventCreatedAt ?? -1)) profiles.set(key, profile)
  }
  return profiles
}

export function peopleSearchKey(query: string): string | null {
  const value = query.trim().replace(/^nostr:/i, '')
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase()
  try {
    const decoded = nip19.decode(value)
    return decoded.type === 'npub' ? decoded.data : decoded.type === 'nprofile' ? decoded.data.pubkey : null
  } catch { return null }
}

export function peopleSearchScore(
  profile: Profile | undefined,
  query: string,
  signals: { followDistance: number; friendsFollowing: number },
): number {
  const text = query.trim().toLowerCase()
  const distance = Number.isFinite(signals.followDistance) ? signals.followDistance : 999
  const friendBoost = 0.005 * signals.friendsFollowing
  if (!text) return -distance + friendBoost
  const names = [profile?.name, profile?.display_name, profile?.username, profile?.nip05]
    .filter((name): name is string => typeof name === 'string').map(name => name.toLowerCase())
  const prefix = names.some(name => name.startsWith(text))
  if (text.length === 1) return prefix ? -distance + friendBoost : -Infinity
  if (!text.split(/\s+/).every(token => names.some(name => name.includes(token)))) return -Infinity
  const exact = names.some(name => name === text)
  return 5 + (exact ? 3 : 0) + (prefix ? 1 : 0) - 0.01 * (distance - 1) + friendBoost
}

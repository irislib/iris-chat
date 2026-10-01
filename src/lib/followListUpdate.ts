import type { Event } from 'nostr-tools'

export function followListUpdate(head: Event | null, pubkey: string, follow: boolean, nowSecs: number) {
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) throw new Error('Invalid user ID')
  const tags = (head?.tags ?? []).filter(tag => follow || tag[0] !== 'p' || tag[1] !== pubkey)
    .map(tag => [...tag])
  if (follow && !tags.some(tag => tag[0] === 'p' && tag[1] === pubkey)) tags.push(['p', pubkey])
  return { kind: 3, tags, content: head?.content ?? '', created_at: Math.max(nowSecs, (head?.created_at ?? 0) + 1) }
}

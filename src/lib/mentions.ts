import { nip19 } from 'nostr-tools'

export interface Mention { start: number; end: number; pubkey: string; label: string }
const controls = /[\u0000-\u001f\u007f-\u009f]/u
export function formatMention(pubkey: string, name: string): string {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return ''
  const npub = nip19.npubEncode(pubkey)
  const label = Array.from(name).filter(c => !controls.test(c) && !'[]\\'.includes(c)).slice(0, 80).join('').trim().replace(/^@+/, '') || npub.slice(0, 12)
  return `[@${label}](nostr:${npub})`
}
export function messageMentions(text: string): Mention[] {
  const found: Mention[] = []
  const pattern = /\[@([^\]\[\\\u0000-\u001f\u007f-\u009f]{1,320})\]\(nostr:(npub1[023456789acdefghjklmnpqrstuvwxyz]{58})\)/gu
  for (const match of text.matchAll(pattern)) {
    if (new TextEncoder().encode('@' + match[1]).length > 321) continue
    try {
      const key = nip19.decode(match[2])
      if (key.type === 'npub' && nip19.npubEncode(key.data) === match[2]) found.push({ start: match.index!, end: match.index! + match[0].length, pubkey: key.data, label: '@' + match[1] })
    } catch { /* A malformed link never identifies a person. */ }
  }
  return found
}
export function displayMentions(text: string, names: Record<string, string> = {}): string {
  for (const mention of messageMentions(text).reverse()) text = text.slice(0, mention.start) + (names[mention.pubkey] ? '@' + names[mention.pubkey] : mention.label) + text.slice(mention.end)
  return text
}
export function mentionsOwner(text: string, owner: string): boolean {
  if (text.startsWith('↩ ')) { const end = text.indexOf('\n\n'); if (end >= 0) text = text.slice(end + 2) }
  return !text.startsWith('Forwarded:\n') && messageMentions(text).some(mention => mention.pubkey === owner)
}

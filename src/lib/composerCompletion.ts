import catalog from './data/emoji-shortcodes.tsv?raw'
import { formatMention, messageMentions, type Mention } from './mentions'
export const emojiShortcodes = catalog.trim().split('\n').map(line => { const [emoji, aliases] = line.split('\t'); return { emoji, aliases: aliases.split(' ') } })
export interface DraftMention extends Mention { wire: string }
export interface ComposerDraft { text: string; mentions: DraftMention[] }
export function decodeDraft(wire: string, names: Record<string, string> = {}): ComposerDraft {
  let text = '', cursor = 0
  const mentions: DraftMention[] = []
  for (const mention of messageMentions(wire)) {
    text += wire.slice(cursor, mention.start)
    const label = names[mention.pubkey] ? '@' + names[mention.pubkey] : mention.label
    mentions.push({ ...mention, start: text.length, end: text.length + label.length, label, wire: wire.slice(mention.start, mention.end) })
    text += label; cursor = mention.end
  }
  return { text: text + wire.slice(cursor), mentions }
}
export function encodeDraft(draft: ComposerDraft): string {
  let text = draft.text
  for (const mention of [...draft.mentions].reverse()) text = text.slice(0, mention.start) + mention.wire + text.slice(mention.end)
  return text
}
/** Edits touching a token make it ordinary text; untouched tokens retain identity. */
export function editDraft(draft: ComposerDraft, text: string): ComposerDraft {
  let start = 0, oldEnd = draft.text.length, end = text.length
  while (start < oldEnd && start < end && draft.text[start] === text[start]) start++
  while (oldEnd > start && end > start && draft.text[oldEnd - 1] === text[end - 1]) { oldEnd--; end-- }
  return { text, mentions: draft.mentions.flatMap(mention => mention.end <= start ? [mention] : mention.start >= oldEnd ? [{ ...mention, start: mention.start + end - oldEnd, end: mention.end + end - oldEnd }] : []) }
}
export function insertCompletion(draft: ComposerDraft, start: number, end: number, label: string, pubkey?: string, trailingSpace = true): ComposerDraft {
  const next = editDraft(draft, draft.text.slice(0, start) + label + (trailingSpace ? ' ' : '') + draft.text.slice(end))
  if (pubkey) next.mentions.push({ start, end: start + label.length, pubkey, label, wire: formatMention(pubkey, label) })
  next.mentions.sort((a,b) => a.start - b.start)
  return next
}
export type Completion = { kind: 'mention' | 'emoji'; start: number; end: number; query: string; closed: boolean }
export function completionAt(text: string, start: number, end = start): Completion | undefined {
  if (start !== end) return
  const prefix = text.slice(Math.max(0, start - 65), start)
  const match = /(?:^|\s)([@:])([^\s@:]{0,63})(:?)$/u.exec(prefix)
  if (!match) return
  const tokenStart = start - match[2].length - 1 - match[3].length
  if (tokenStart > 0 && !/\s/u.test(text[tokenStart - 1])) return
  const kind = match[1] === '@' ? 'mention' : 'emoji'
  if (kind === 'emoji' && (!/^[a-zA-Z0-9_+\-]*$/.test(match[2]) || match[2].length < (match[3] ? 1 : 2))) return
  if (kind === 'mention' && match[3]) return
  return { kind, start: start - match[2].length - 1 - match[3].length, end: start, query: match[2], closed: !!match[3] }
}
export function emojiSuggestions(query: string) {
  query = query.toLowerCase().replaceAll('-', '_')
  return emojiShortcodes.filter(item => item.aliases.some(alias => alias.includes(query)))
    .sort((a,b) => (b.aliases.includes(query) ? 2 : b.aliases.some(alias => alias.startsWith(query)) ? 1 : 0) - (a.aliases.includes(query) ? 2 : a.aliases.some(alias => alias.startsWith(query)) ? 1 : 0)).slice(0, 6)
}
export function exactEmoji(query: string) { return emojiShortcodes.find(item => item.aliases.includes(query.toLowerCase().replaceAll('-', '_')))?.emoji }

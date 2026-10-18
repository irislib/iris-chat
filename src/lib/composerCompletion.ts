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
export interface DraftEditRange { start: number; end: number; inputType: string }
/** Use the editor's pre-edit selection, never a diff of equal-looking names.
 * Unknown/non-matching native edits conservatively leave plain text. */
export function editDraft(draft: ComposerDraft, text: string, edit?: DraftEditRange): ComposerDraft {
  if (!edit) return { text, mentions: [] }
  let { start, end } = edit
  if (start === end && edit.inputType.startsWith('delete')) {
    const removed = draft.text.length - text.length
    if (removed < 0) return { text, mentions: [] }
    if (edit.inputType.endsWith('Backward')) start -= removed
    else if (edit.inputType.endsWith('Forward')) end += removed
    else return { text, mentions: [] }
  }
  const insertedEnd = text.length - (draft.text.length - end)
  if (start < 0 || end < start || end > draft.text.length || insertedEnd < start ||
    text.slice(0,start) !== draft.text.slice(0,start) || text.slice(insertedEnd) !== draft.text.slice(end)) return { text, mentions: [] }
  const shift = insertedEnd - end
  return { text, mentions: draft.mentions.flatMap(mention => mention.end <= start ? [mention] : mention.start >= end ? [{ ...mention, start: mention.start + shift, end: mention.end + shift }] : []) }
}
export interface ComposerSnapshot { draft: ComposerDraft; start: number; end: number }
export function composerSnapshot(draft: ComposerDraft, start: number, end = start): ComposerSnapshot {
  return { draft: { text: draft.text, mentions: draft.mentions.map(mention => ({ ...mention })) }, start, end }
}
/** Native textarea undo cannot restore our identity metadata after a completion. */
export class ComposerHistory {
  private entries: Array<{ before: ComposerSnapshot; after: ComposerSnapshot }> = []
  private cursor = 0
  clear() { this.entries = []; this.cursor = 0 }
  record(before: ComposerSnapshot, after: ComposerSnapshot) {
    if (before.draft.text === after.draft.text && encodeDraft(before.draft) === encodeDraft(after.draft)) return
    this.entries.splice(this.cursor)
    this.entries.push({ before: composerSnapshot(before.draft,before.start,before.end), after: composerSnapshot(after.draft,after.start,after.end) })
    if (this.entries.length > 100) this.entries.shift()
    this.cursor = this.entries.length
  }
  undo(): ComposerSnapshot | undefined { return this.cursor > 0 ? this.entries[--this.cursor].before : undefined }
  redo(): ComposerSnapshot | undefined { return this.cursor < this.entries.length ? this.entries[this.cursor++].after : undefined }
}
export function insertCompletion(draft: ComposerDraft, start: number, end: number, label: string, pubkey?: string, trailingSpace = true): ComposerDraft {
  const next = editDraft(draft, draft.text.slice(0, start) + label + (trailingSpace ? ' ' : '') + draft.text.slice(end), { start, end, inputType:'insertReplacementText' })
  if (pubkey) next.mentions.push({ start, end: start + label.length, pubkey, label, wire: formatMention(pubkey, label) })
  next.mentions.sort((a,b) => a.start - b.start)
  return next
}
export type Completion = { kind: 'mention' | 'emoji'; start: number; end: number; query: string; closed: boolean }
export function completionAt(text: string, start: number, end = start): Completion | undefined {
  if (start !== end) return
  const at = text.lastIndexOf('@', start - 1)
  if (at >= 0 && (at === 0 || /\s/u.test(text[at - 1]))) {
    const query = text.slice(at + 1, start)
    if (query.length <= 64 && /^[\p{L}\p{N} _-]*$/u.test(query))
      return { kind: 'mention', start: at, end: start, query, closed: false }
  }
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

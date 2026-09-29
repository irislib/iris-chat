/** Missing = unmuted, zero = indefinitely, otherwise Unix seconds. */
export type ChatMutes = Record<string, number>
export const CHAT_MUTE_DURATIONS = [
  { label: '1 hour', seconds: 3_600 }, { label: '8 hours', seconds: 28_800 },
  { label: '1 day', seconds: 86_400 }, { label: '1 week', seconds: 604_800 },
]
export const chatMutesKey = (owner: string) => `chat-mutes:${owner}`
export function normalizeChatMutes(value: unknown): ChatMutes {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([id, until]) =>
    id.length > 0 && typeof until === 'number' && Number.isSafeInteger(until) && until >= 0))
}
export function isChatMuted(mutes: ChatMutes, chatId: string, now = Math.floor(Date.now() / 1000)): boolean {
  const until = mutes[chatId]
  return until === 0 || until > now
}
export type MutedMessageFilter = { kinds: number[]; authors: string[]; since?: number }
export function mutedMessageFilters(authorsByChat: Map<string, string[]>, mutes: ChatMutes,
  kind: number, supportsTimed: boolean, now = Math.floor(Date.now() / 1000)): MutedMessageFilter[] {
  const authors = new Set<string>()
  const delayed = new Map<number, Set<string>>()
  for (const [chat, keys] of authorsByChat) {
    const until = mutes[chat]
    if (!isChatMuted(mutes, chat, now)) keys.forEach(key => authors.add(key))
    else if (until > 0 && supportsTimed) {
      const group = delayed.get(until) ?? new Set<string>()
      keys.forEach(key => group.add(key)); delayed.set(until, group)
    }
  }
  const filters: MutedMessageFilter[] = []
  if (authors.size) filters.push({ kinds: [kind], authors: [...authors].sort() })
  for (const [since, keys] of [...delayed].sort(([a], [b]) => a - b))
    filters.push({ kinds: [kind], authors: [...keys].sort(), since })
  // An explicit empty list matches nothing; never replace it with a wildcard.
  return filters.length ? filters : [{ kinds: [kind], authors: [] }]
}

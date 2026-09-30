/** Private inner control, encrypted to this account's linked devices only. */
export const CHAT_MUTE_KIND = 10449

export interface ChatMuteState {
  chatId: string
  untilSecs: number | null // null: unmuted; 0: forever; otherwise Unix seconds
  updatedAtMs: number
}

export function isChatMuteState(value: unknown): value is ChatMuteState {
  if (!value || typeof value !== 'object') return false
  const state = value as ChatMuteState
  return typeof state.chatId === 'string' &&
    (/^[0-9a-f]{64}$/.test(state.chatId) || /^group:[^\x00-\x20]{1,128}$/.test(state.chatId)) &&
    Number.isSafeInteger(state.updatedAtMs) && state.updatedAtMs > 0 &&
    (state.untilSecs === null || (Number.isSafeInteger(state.untilSecs) &&
      state.untilSecs >= 0 && state.untilSecs <= 253_402_300_799))
}

// Same deterministic tie-break as Rust's (u64, Option<u64>) ordering.
export function isNewerChatMute(incoming: ChatMuteState, current?: ChatMuteState): boolean {
  return !current || incoming.updatedAtMs > current.updatedAtMs ||
    (incoming.updatedAtMs === current.updatedAtMs &&
      (incoming.untilSecs ?? -1) > (current.untilSecs ?? -1))
}

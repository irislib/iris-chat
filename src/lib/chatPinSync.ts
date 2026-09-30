/** Private inner control, encrypted only to this account's linked devices. */
export const CHAT_PIN_KIND = 10450
export interface ChatPinState { chatId: string; pinned: boolean; updatedAtMs: number }
export function isChatPinState(value: unknown): value is ChatPinState {
  if (!value || typeof value !== 'object') return false
  const state = value as ChatPinState
  return typeof state.chatId === 'string' &&
    (/^[0-9a-f]{64}$/.test(state.chatId) || /^group:[^\x00-\x20]{1,128}$/.test(state.chatId)) &&
    typeof state.pinned === 'boolean' && Number.isSafeInteger(state.updatedAtMs) && state.updatedAtMs > 0
}
export function isNewerChatPin(incoming: ChatPinState, current?: ChatPinState): boolean {
  return !current || incoming.updatedAtMs > current.updatedAtMs ||
    (incoming.updatedAtMs === current.updatedAtMs && incoming.pinned && !current.pinned)
}

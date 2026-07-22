import { createPersistedSettings } from './createSettings'

export interface TypingSettings extends Record<string, unknown> {
  sendTypingIndicators: boolean
}

const { store, update } = createPersistedSettings<TypingSettings>(
  'iris-chat-typing',
  { sendTypingIndicators: false },
)

export const typingSettings = store

export function setSendTypingIndicators(value: boolean): void {
  update({ sendTypingIndicators: value })
}

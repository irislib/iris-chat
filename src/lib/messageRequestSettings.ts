import { createPersistedSettings } from './createSettings'

export interface MessageRequestSettings extends Record<string, unknown> {
  // If disabled: incoming chats from non-followed users are ignored unless already accepted.
  receiveMessageRequests: boolean
}

const { store, update } = createPersistedSettings<MessageRequestSettings>(
  'iris-chat-message-requests',
  { receiveMessageRequests: true },
)

export const messageRequestSettings = store

export function setReceiveMessageRequests(value: boolean): void {
  update({ receiveMessageRequests: value })
}


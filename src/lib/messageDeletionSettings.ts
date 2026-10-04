import { createPersistedSettings } from './createSettings'

const { store, update } = createPersistedSettings(
  'iris-chat-message-deletion',
  { allowDeletionByOthers: true },
  parsed => ({ allowDeletionByOthers: typeof parsed.allowDeletionByOthers === 'boolean' ? parsed.allowDeletionByOthers : true }),
)

export const messageDeletionSettings = store
export function setAllowDeletionByOthers(value: boolean): void {
  update({ allowDeletionByOthers: value })
}

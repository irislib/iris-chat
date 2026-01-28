/**
 * Per-chat message draft store.
 *
 * Keeps draft text in memory so switching between chats preserves
 * whatever the user was typing. Drafts are intentionally not persisted
 * to IndexedDB — they live only for the current browser session.
 */

import { writable, get } from 'svelte/store'

/** Map of chatId -> draft text */
const drafts = writable<Map<string, string>>(new Map())

/** Get draft for a chat */
export function getDraft(chatId: string): string {
  return get(drafts).get(chatId) || ''
}

/** Set draft for a chat */
export function setDraft(chatId: string, text: string): void {
  drafts.update(map => {
    if (text) {
      map.set(chatId, text)
    } else {
      map.delete(chatId)
    }
    return map
  })
}

/** Clear draft for a chat (e.g. after sending) */
export function clearDraft(chatId: string): void {
  setDraft(chatId, '')
}

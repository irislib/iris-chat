import { get } from 'svelte/store'
import { restorePrivateBlocks, privateStateEvents, privateHistoryAllowed, projectMessageRead, projectNameApproval } from './privateStateStore'
import { privateEventState, type NameApproval } from './privateStateProtocol'
import type { StoredMessage } from './storage'
/** Refresh only the active account; durable records stay independent of UI stores. */
export async function refreshPrivateStateView(owner: string, authorized: () => boolean): Promise<void> {
  await restorePrivateBlocks(owner)
  const [{ chats, currentChat }, { groupMessages }] = await Promise.all([import('./chat'), import('./groups')])
  for await (const event of privateStateEvents(owner)) if (event.kind === 10455 && authorized()) await projectNameApproval(owner, (privateEventState(event) as NameApproval).contact)
  const project = async <T extends Omit<StoredMessage, 'sessionId'>>(chatId: string, rows: T[]): Promise<T[]> => {
    const next: T[] = []
    for (const row of rows) if (await privateHistoryAllowed(owner, row.isMine ? owner : row.senderPubkey ?? chatId, Math.floor(row.timestamp / 1000))) next.push({ ...row, status: (await projectMessageRead(owner, { ...row, sessionId: chatId })).status })
    return next
  }
  for (const [id, chat] of get(chats)) {
    const messages = await project(id, chat.messages)
    if (!authorized()) return
    if (messages.length === chat.messages.length && messages.every((m,i) => m.status === chat.messages[i].status)) continue
    // A network event may have appended a message while projection awaited storage.
    if (get(chats).get(id) !== chat) continue
    const next = { ...chat, messages }
    chats.update(all => new Map(all).set(id, next))
    if (get(currentChat)?.id === id) currentChat.set(next)
  }
  for (const [id, rows] of get(groupMessages)) {
    const next = await project(`group:${id}`, rows)
    if (!authorized()) return
    if (get(groupMessages).get(id) === rows && (next.length !== rows.length || next.some((m,i) => m.status !== rows[i].status))) groupMessages.update(all => new Map(all).set(id, next))
  }
}

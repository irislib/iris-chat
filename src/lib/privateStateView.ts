import { get } from 'svelte/store'
import { privateStateEvents, loadPendingReadsMap, isTimestampBlocked, projectNameApproval } from './privateStateStore'
import { blockedIntervals, comparePrivateEvents, privateEventState, type BlockState, type NameApproval } from './privateStateProtocol'
import { replaceBlockedContacts } from './privateBlockProjection'
import { db, type StoredMessage } from './storage'
import type { PrivateEvent } from 'nostr-social-graph/privateEvents'

/** Refresh only the active account; durable records stay independent of UI stores. */
export async function refreshPrivateStateView(owner: string, authorized: () => boolean): Promise<void> {
  const blockEventsByTarget = new Map<string, PrivateEvent[]>()
  const nameContacts = new Set<string>()
  for await (const event of privateStateEvents(owner)) {
    const state = privateEventState(event)
    if (!state || state.owner !== owner) continue
    if (event.kind === 10454 && 'target' in state) {
      let list = blockEventsByTarget.get(state.target)
      if (!list) { list = []; blockEventsByTarget.set(state.target, list) }
      list.push(event)
    } else if (event.kind === 10455 && 'contact' in state) {
      nameContacts.add((state as NameApproval).contact)
    }
  }
  const blockedNow = new Set<string>()
  const intervalsByAuthor = new Map<string, Array<[number, number | null]>>()
  for (const [target, events] of blockEventsByTarget) {
    const sorted = events.sort(comparePrivateEvents)
    if ((privateEventState(sorted.at(-1)!) as BlockState).blocked) blockedNow.add(target)
    intervalsByAuthor.set(target, blockedIntervals(sorted))
  }
  replaceBlockedContacts(owner, blockedNow)

  const [{ chats, currentChat }, { groupMessages }, readsByChat] = await Promise.all([
    import('./chat'),
    import('./groups'),
    loadPendingReadsMap(owner),
  ])
  for (const contact of nameContacts) {
    if (!authorized()) return
    await projectNameApproval(owner, contact)
  }
  if (!authorized()) return

  const chatSnapshot = Array.from(get(chats).entries())
  const groupSnapshot = Array.from(get(groupMessages).entries())

  // Batch-check DB seen status once for all unread incoming non-call messages.
  const unreadIds: string[] = []
  for (const [, chat] of chatSnapshot) {
    for (const row of chat.messages) if (!row.isMine && !row.call && row.status !== 'seen') unreadIds.push(row.id)
  }
  for (const [, rows] of groupSnapshot) {
    for (const row of rows) if (!row.isMine && !row.call && row.status !== 'seen') unreadIds.push(row.id)
  }
  const dbSeen = new Map<string, StoredMessage>()
  const nowSecs = Date.now() / 1000
  for (let i = 0; i < unreadIds.length; i += 512) {
    const found = await db.messages.bulkGet(unreadIds.slice(i, i + 512))
    for (const row of found) {
      if (row && !row.isMine && !row.call && row.status === 'seen' && (row.expiresAt === undefined || row.expiresAt > nowSecs)) {
        dbSeen.set(row.id, row)
      }
    }
  }
  if (!authorized()) return

  const project = <T extends Omit<StoredMessage, 'sessionId'>>(chatId: string, rows: T[]): { next: T[]; changed: boolean } => {
    const pendingReads = readsByChat.get(chatId)
    const next: T[] = []
    let changed = false
    for (const row of rows) {
      const createdSecs = Math.floor(row.timestamp / 1000)
      if (!row.isMine) {
        const author = row.senderPubkey ?? chatId
        if (author !== owner && isTimestampBlocked(intervalsByAuthor.get(author), createdSecs)) {
          changed = true
          continue
        }
      }
      if (!row.isMine && !row.call && row.status !== 'seen') {
        const seenRow = dbSeen.get(row.id)
        const seenInDb = seenRow?.sessionId === chatId && Math.floor(seenRow.timestamp / 1000) === createdSecs
        const seenPending = pendingReads?.get(row.id)?.createdAtSecs === createdSecs
        if (seenInDb || seenPending) {
          next.push({ ...row, status: 'seen' })
          changed = true
          continue
        }
      }
      next.push(row)
    }
    return { next, changed }
  }

  const chatUpdates: Array<[string, typeof chatSnapshot[number][1]]> = []
  for (const [id, chat] of chatSnapshot) {
    const { next: messages, changed } = project(id, chat.messages)
    if (changed && get(chats).get(id) === chat) chatUpdates.push([id, { ...chat, messages }])
  }
  if (chatUpdates.length) {
    chats.update(all => {
      const next = new Map(all)
      for (const [id, updated] of chatUpdates) next.set(id, updated)
      return next
    })
    const activeId = get(currentChat)?.id
    const activeUpdated = activeId ? chatUpdates.find(([id]) => id === activeId)?.[1] : undefined
    if (activeUpdated) currentChat.set(activeUpdated)
  }

  const groupUpdates: Array<[string, typeof groupSnapshot[number][1]]> = []
  for (const [id, rows] of groupSnapshot) {
    const { next, changed } = project(`group:${id}`, rows)
    if (changed && get(groupMessages).get(id) === rows) groupUpdates.push([id, next])
  }
  if (groupUpdates.length) {
    groupMessages.update(all => {
      const next = new Map(all)
      for (const [id, updated] of groupUpdates) next.set(id, updated)
      return next
    })
  }
}

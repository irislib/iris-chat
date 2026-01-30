import { writable, get } from 'svelte/store'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { CHAT_MESSAGE_KIND, REACTION_KIND, TYPING_KIND, parseReaction } from 'nostr-double-ratchet'
import type { Rumor } from 'nostr-double-ratchet'
import type { VerifiedEvent } from 'nostr-tools'
import { ndk, getPubkey } from './identity'
import { chats, type ChatMessage, type ChatSession } from './chat'
import {
  saveGroup as saveGroupToDb,
  getAllGroups,
  deleteGroupFromDb,
  saveMessage as saveMessageToDb,
  getMessagesForSession,
  deleteMessagesForSession,
  type StoredGroup,
  type StoredMessage
} from './storage'
import { setRemoteTyping, clearRemoteTyping, TYPING_EXPIRY_MS } from './typingState'

export const GROUP_METADATA_KIND = 40

export interface Group {
  id: string
  name: string
  description?: string
  picture?: string
  members: string[]
  admins: string[]
  createdAt: number
}

export interface GroupMessage extends ChatMessage {
  senderPubkey?: string
}

export interface GroupMetadata {
  id: string
  name: string
  description?: string
  picture?: string
  members: string[]
  admins: string[]
}

export const groups = writable<Map<string, Group>>(new Map())
export const groupMessages = writable<Map<string, GroupMessage[]>>(new Map())
export const currentGroupId = writable<string | null>(null)

// Save session state after fan-out rotates keys - imported dynamically to avoid circular deps
let saveSessionToStorageFn: ((session: ChatSession) => Promise<void>) | null = null

export function setSaveSessionFn(fn: (session: ChatSession) => Promise<void>): void {
  saveSessionToStorageFn = fn
}

export function isAdmin(group: Group, pubkey: string): boolean {
  return group.admins.includes(pubkey)
}

function fanOutToMembers(groupId: string, partialEvent: { content: string, kind: number, tags: string[][] }, recipientOverride?: string[]): void {
  const currentGroups = get(groups)
  const group = currentGroups.get(groupId)
  if (!group) return

  const myPubkey = getPubkey()
  if (!myPubkey) return

  const currentChats = get(chats)
  const ndkInstance = get(ndk)
  const now = Math.floor(Date.now() / 1000)

  const tags = [...partialEvent.tags, ['l', groupId], ['ms', Date.now().toString()]]
  const recipients = recipientOverride || group.members

  for (const memberPubkey of recipients) {
    if (memberPubkey === myPubkey) continue

    const chatSession = currentChats.get(memberPubkey)
    if (!chatSession) {
      console.warn('[groups] No chat session for member:', memberPubkey.slice(0, 8))
      continue
    }

    try {
      const { event } = chatSession.session.sendEvent({
        content: partialEvent.content,
        kind: partialEvent.kind,
        tags,
        pubkey: myPubkey,
        created_at: now
      })

      const ndkPublishEvent = new NDKEvent(ndkInstance, event)
      ndkPublishEvent.publish().catch(e =>
        console.error('[groups] Failed to publish to', memberPubkey.slice(0, 8), e)
      )

      if (saveSessionToStorageFn) {
        saveSessionToStorageFn(chatSession).catch(e =>
          console.error('[groups] Failed to save session:', e)
        )
      }
    } catch (e) {
      console.error('[groups] Failed to send to member:', memberPubkey.slice(0, 8), e)
    }
  }
}

function buildMetadataContent(group: Group): string {
  const metadata: GroupMetadata = {
    id: group.id,
    name: group.name,
    members: group.members,
    admins: group.admins,
    ...(group.description && { description: group.description }),
    ...(group.picture && { picture: group.picture })
  }
  return JSON.stringify(metadata)
}

function saveGroupState(group: Group): void {
  const storedGroup: StoredGroup = {
    id: group.id,
    name: group.name,
    members: group.members,
    admins: group.admins,
    createdAt: group.createdAt,
    ...(group.description && { description: group.description }),
    ...(group.picture && { picture: group.picture })
  }
  saveGroupToDb(storedGroup).catch(e => console.error('[groups] Failed to save group:', e))
}

export function createGroup(name: string, memberPubkeys: string[]): Group {
  const myPubkey = getPubkey()
  if (!myPubkey) throw new Error('Not logged in')

  const id = crypto.randomUUID()
  const allMembers = [myPubkey, ...memberPubkeys.filter(p => p !== myPubkey)]

  const group: Group = {
    id,
    name,
    members: allMembers,
    admins: [myPubkey],
    createdAt: Date.now()
  }

  groups.update(g => {
    g.set(id, group)
    return g
  })
  groupMessages.update(gm => {
    gm.set(id, [])
    return gm
  })

  saveGroupState(group)

  fanOutToMembers(id, {
    content: buildMetadataContent(group),
    kind: GROUP_METADATA_KIND,
    tags: []
  })

  return group
}

export function addGroupMember(groupId: string, pubkey: string): void {
  const myPubkey = getPubkey()
  if (!myPubkey) return

  const currentGroups = get(groups)
  const group = currentGroups.get(groupId)
  if (!group) return
  if (!isAdmin(group, myPubkey)) return
  if (group.members.includes(pubkey)) return

  // Verify we have a chat session with the new member
  const currentChats = get(chats)
  if (!currentChats.has(pubkey)) return

  const updated: Group = {
    ...group,
    members: [...group.members, pubkey]
  }

  groups.update(g => {
    g.set(groupId, updated)
    return g
  })
  saveGroupState(updated)

  // Fan out to all members including the new one
  fanOutToMembers(groupId, {
    content: buildMetadataContent(updated),
    kind: GROUP_METADATA_KIND,
    tags: []
  }, updated.members)
}

export function removeGroupMember(groupId: string, pubkey: string): void {
  const myPubkey = getPubkey()
  if (!myPubkey) return

  const currentGroups = get(groups)
  const group = currentGroups.get(groupId)
  if (!group) return
  if (!isAdmin(group, myPubkey)) return
  if (!group.members.includes(pubkey)) return
  // Can't remove yourself via this function
  if (pubkey === myPubkey) return

  const updated: Group = {
    ...group,
    members: group.members.filter(m => m !== pubkey),
    admins: group.admins.filter(a => a !== pubkey)
  }

  groups.update(g => {
    g.set(groupId, updated)
    return g
  })
  saveGroupState(updated)

  // Fan out to all members including the removed one so they learn of removal
  fanOutToMembers(groupId, {
    content: buildMetadataContent(updated),
    kind: GROUP_METADATA_KIND,
    tags: []
  }, [...updated.members, pubkey])
}

export function updateGroupInfo(groupId: string, updates: { name?: string, description?: string, picture?: string }): void {
  const myPubkey = getPubkey()
  if (!myPubkey) return

  const currentGroups = get(groups)
  const group = currentGroups.get(groupId)
  if (!group) return
  if (!isAdmin(group, myPubkey)) return

  const updated: Group = { ...group }
  if (updates.name !== undefined) updated.name = updates.name
  if (updates.description !== undefined) updated.description = updates.description
  if (updates.picture !== undefined) updated.picture = updates.picture

  groups.update(g => {
    g.set(groupId, updated)
    return g
  })
  saveGroupState(updated)

  fanOutToMembers(groupId, {
    content: buildMetadataContent(updated),
    kind: GROUP_METADATA_KIND,
    tags: []
  })
}

export function addGroupAdmin(groupId: string, pubkey: string): void {
  const myPubkey = getPubkey()
  if (!myPubkey) return

  const currentGroups = get(groups)
  const group = currentGroups.get(groupId)
  if (!group) return
  if (!isAdmin(group, myPubkey)) return
  if (!group.members.includes(pubkey)) return
  if (group.admins.includes(pubkey)) return

  const updated: Group = {
    ...group,
    admins: [...group.admins, pubkey]
  }

  groups.update(g => {
    g.set(groupId, updated)
    return g
  })
  saveGroupState(updated)

  fanOutToMembers(groupId, {
    content: buildMetadataContent(updated),
    kind: GROUP_METADATA_KIND,
    tags: []
  })
}

export function removeGroupAdmin(groupId: string, pubkey: string): void {
  const myPubkey = getPubkey()
  if (!myPubkey) return

  const currentGroups = get(groups)
  const group = currentGroups.get(groupId)
  if (!group) return
  if (!isAdmin(group, myPubkey)) return
  if (!group.admins.includes(pubkey)) return
  // Must keep at least one admin
  if (group.admins.length <= 1) return

  const updated: Group = {
    ...group,
    admins: group.admins.filter(a => a !== pubkey)
  }

  groups.update(g => {
    g.set(groupId, updated)
    return g
  })
  saveGroupState(updated)

  fanOutToMembers(groupId, {
    content: buildMetadataContent(updated),
    kind: GROUP_METADATA_KIND,
    tags: []
  })
}

export function sendGroupMessage(groupId: string, text: string, replyTo?: string): void {
  const myPubkey = getPubkey()
  if (!myPubkey) return

  const tags: string[][] = []
  if (replyTo) {
    tags.push(['e', replyTo, '', 'reply'])
  }

  const message: GroupMessage = {
    id: crypto.randomUUID(),
    content: text,
    timestamp: Date.now(),
    isMine: true,
    senderPubkey: myPubkey,
    ...(replyTo && { replyTo })
  }

  groupMessages.update(gm => {
    const msgs = gm.get(groupId) || []
    gm.set(groupId, [...msgs, message])
    return gm
  })

  saveGroupMessageToStorage(groupId, message)

  fanOutToMembers(groupId, {
    content: text,
    kind: CHAT_MESSAGE_KIND,
    tags
  })
}

export function sendGroupReaction(groupId: string, messageId: string, emoji: string): void {
  const myPubkey = getPubkey()
  if (!myPubkey) return

  groupMessages.update(gm => {
    const msgs = gm.get(groupId) || []
    const idx = msgs.findIndex(m => m.id === messageId)
    if (idx === -1) return gm

    const message = msgs[idx]
    const reactions: Record<string, string[]> = {}
    for (const [e, users] of Object.entries(message.reactions || {})) {
      const filtered = users.filter(u => u !== myPubkey)
      if (filtered.length > 0) reactions[e] = filtered
    }
    if (!reactions[emoji]) reactions[emoji] = []
    reactions[emoji] = [...reactions[emoji], myPubkey]

    const updated = [...msgs]
    updated[idx] = { ...message, reactions }
    gm.set(groupId, updated)
    return gm
  })

  const msgs = get(groupMessages).get(groupId) || []
  const updatedMsg = msgs.find(m => m.id === messageId)
  if (updatedMsg) saveGroupMessageToStorage(groupId, updatedMsg)

  fanOutToMembers(groupId, {
    content: JSON.stringify({ type: 'reaction', messageId, emoji }),
    kind: REACTION_KIND,
    tags: [['e', messageId]]
  })
}

export function sendGroupTypingEvent(groupId: string): void {
  fanOutToMembers(groupId, {
    content: 'typing',
    kind: TYPING_KIND,
    tags: []
  })
}

export function handleGroupEvent(rumor: Rumor, senderPubkey: string, _outerEvent?: VerifiedEvent): void {
  const groupTag = rumor.tags?.find((t: string[]) => t[0] === 'l')
  if (!groupTag) return
  const groupId = groupTag[1]

  if (rumor.kind === GROUP_METADATA_KIND) {
    handleGroupMetadata(rumor, senderPubkey)
    return
  }

  const currentGroups = get(groups)
  if (!currentGroups.has(groupId)) return

  if (rumor.kind === TYPING_KIND) {
    const ageMs = Date.now() - rumor.created_at * 1000
    if (ageMs < TYPING_EXPIRY_MS) {
      setRemoteTyping(`group:${groupId}`, rumor.created_at)
    }
    return
  }

  if (rumor.kind === REACTION_KIND) {
    handleGroupReaction(groupId, rumor, senderPubkey)
    return
  }

  if (rumor.kind === CHAT_MESSAGE_KIND) {
    clearRemoteTyping(`group:${groupId}`, rumor.created_at)
    handleGroupMessage(groupId, rumor, senderPubkey)
    return
  }
}

function handleGroupMetadata(rumor: Rumor, senderPubkey: string): void {
  try {
    const metadata = JSON.parse(rumor.content) as Partial<GroupMetadata>
    const { id, name, members, admins } = metadata
    if (!id || !name || !Array.isArray(members) || !Array.isArray(admins)) return
    if (admins.length === 0) return

    const myPubkey = getPubkey()
    if (!myPubkey) return

    const currentGroups = get(groups)
    const existing = currentGroups.get(id)

    if (existing) {
      // Update from admin only
      if (!isAdmin(existing, senderPubkey)) {
        console.warn('[groups] Rejected metadata update from non-admin:', senderPubkey.slice(0, 8))
        return
      }

      const updated: Group = {
        ...existing,
        name,
        members,
        admins,
        description: metadata.description,
        picture: metadata.picture
      }

      // If we were removed from the group, delete it locally
      if (!members.includes(myPubkey)) {
        deleteGroup(id)
        return
      }

      groups.update(g => {
        g.set(id, updated)
        return g
      })
      saveGroupState(updated)
    } else {
      // New group - sender must be in admins list
      if (!admins.includes(senderPubkey)) return
      if (!members.includes(myPubkey)) return

      const group: Group = {
        id,
        name,
        members,
        admins,
        description: metadata.description,
        picture: metadata.picture,
        createdAt: rumor.created_at * 1000
      }

      groups.update(g => {
        g.set(id, group)
        return g
      })
      groupMessages.update(gm => {
        if (!gm.has(id)) gm.set(id, [])
        return gm
      })
      saveGroupState(group)

      console.log('[groups] Joined group:', name, 'from', senderPubkey.slice(0, 8))
    }
  } catch (e) {
    console.error('[groups] Failed to parse group metadata:', e)
  }
}

function handleGroupMessage(groupId: string, rumor: Rumor, senderPubkey: string): void {
  const myPubkey = getPubkey()
  const isMine = senderPubkey === myPubkey
  if (isMine) return

  const replyTag = rumor.tags?.find(
    (tag: string[]) => tag[0] === 'e' && tag[3] === 'reply'
  )?.[1] || rumor.tags?.find(
    (tag: string[]) => tag[0] === 'e' && !rumor.tags?.some((t: string[]) => t[0] === 'e' && t[3] === 'root')
  )?.[1]

  const message: GroupMessage = {
    id: rumor.id,
    content: rumor.content,
    timestamp: rumor.created_at * 1000,
    isMine: false,
    senderPubkey,
    ...(replyTag && { replyTo: replyTag })
  }

  groupMessages.update(gm => {
    const msgs = gm.get(groupId) || []
    if (msgs.some(m => m.id === message.id)) return gm
    gm.set(groupId, [...msgs, message].sort((a, b) => a.timestamp - b.timestamp))
    return gm
  })

  saveGroupMessageToStorage(groupId, message)
}

function handleGroupReaction(groupId: string, rumor: Rumor, fromPubkey: string): void {
  const parsed = parseReaction(rumor.content)
  const emoji = parsed?.emoji ?? rumor.content
  const messageId = parsed?.messageId ?? rumor.tags?.find((t: string[]) => t[0] === 'e')?.[1]
  if (!emoji || !messageId) return

  groupMessages.update(gm => {
    const msgs = gm.get(groupId) || []
    const idx = msgs.findIndex(m => m.id === messageId)
    if (idx === -1) return gm

    const message = msgs[idx]
    const reactions: Record<string, string[]> = {}
    for (const [e, users] of Object.entries(message.reactions || {})) {
      const filtered = users.filter(u => u !== fromPubkey)
      if (filtered.length > 0) reactions[e] = filtered
    }
    if (!reactions[emoji]) reactions[emoji] = []
    reactions[emoji] = [...reactions[emoji], fromPubkey]

    const updated = [...msgs]
    updated[idx] = { ...message, reactions }
    gm.set(groupId, updated)
    return gm
  })

  const msgs = get(groupMessages).get(groupId) || []
  const updatedMsg = msgs.find(m => m.id === messageId)
  if (updatedMsg) saveGroupMessageToStorage(groupId, updatedMsg)
}

async function saveGroupMessageToStorage(groupId: string, message: GroupMessage): Promise<void> {
  try {
    const reactions = message.reactions
      ? JSON.parse(JSON.stringify(message.reactions))
      : undefined

    const storedMessage: StoredMessage = {
      id: message.id,
      sessionId: `group:${groupId}`,
      content: message.content,
      timestamp: message.timestamp,
      isMine: message.isMine,
      ...(message.replyTo && { replyTo: message.replyTo }),
      reactions,
      senderPubkey: message.senderPubkey
    }
    await saveMessageToDb(storedMessage)
  } catch (e) {
    console.error('[groups] Failed to save message:', e)
  }
}

export async function loadGroupsFromStorage(): Promise<void> {
  try {
    const storedGroups = await getAllGroups()

    for (const stored of storedGroups) {
      const group: Group = {
        id: stored.id,
        name: stored.name,
        description: stored.description,
        picture: stored.picture,
        members: stored.members,
        admins: stored.admins || [],
        createdAt: stored.createdAt
      }

      groups.update(g => {
        g.set(group.id, group)
        return g
      })

      const storedMessages = await getMessagesForSession(`group:${group.id}`)
      const messages: GroupMessage[] = storedMessages
        .map(m => ({
          id: m.id,
          content: m.content,
          timestamp: m.timestamp,
          isMine: m.isMine,
          senderPubkey: m.senderPubkey,
          ...(m.replyTo && { replyTo: m.replyTo }),
          reactions: m.reactions
        }))
        .sort((a, b) => a.timestamp - b.timestamp)

      groupMessages.update(gm => {
        gm.set(group.id, messages)
        return gm
      })
    }
  } catch (e) {
    console.error('[groups] Failed to load groups from storage:', e)
  }
}

export async function deleteGroup(groupId: string): Promise<void> {
  groups.update(g => {
    g.delete(groupId)
    return g
  })
  groupMessages.update(gm => {
    gm.delete(groupId)
    return gm
  })

  const currentId = get(currentGroupId)
  if (currentId === groupId) {
    currentGroupId.set(null)
  }

  await deleteGroupFromDb(groupId)
  await deleteMessagesForSession(`group:${groupId}`)
}

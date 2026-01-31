import { writable, get } from 'svelte/store'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import {
  CHAT_MESSAGE_KIND, REACTION_KIND, TYPING_KIND, parseReaction,
  GROUP_METADATA_KIND,
  type GroupData,
  type EventCallback,
  isGroupAdmin,
  createGroupData,
  buildGroupMetadataContent,
  parseGroupMetadata,
  validateMetadataUpdate,
  validateMetadataCreation,
  applyMetadataUpdate,
  addGroupMember as libAddMember,
  removeGroupMember as libRemoveMember,
  updateGroupData,
  addGroupAdmin as libAddAdmin,
  removeGroupAdmin as libRemoveAdmin,
} from 'nostr-double-ratchet'
import type { Rumor } from 'nostr-double-ratchet'
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
import { setupGroupChannel, teardownGroupChannel } from './groupChannels'

export { GROUP_METADATA_KIND }
export type Group = GroupData

type OuterEvent = Parameters<EventCallback>[1]

export interface GroupMessage extends ChatMessage {
  senderPubkey?: string
}

export const groups = writable<Map<string, Group>>(new Map())
export const groupMessages = writable<Map<string, GroupMessage[]>>(new Map())
export const currentGroupId = writable<string | null>(null)

// Save session state after fan-out rotates keys - imported dynamically to avoid circular deps
let saveSessionToStorageFn: ((session: ChatSession) => Promise<void>) | null = null

export function setSaveSessionFn(fn: (session: ChatSession) => Promise<void>): void {
  saveSessionToStorageFn = fn
}

export const isAdmin = isGroupAdmin

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


function saveGroupState(group: Group): void {
  const storedGroup: StoredGroup = {
    id: group.id,
    name: group.name,
    members: group.members,
    admins: group.admins,
    createdAt: group.createdAt,
    ...(group.description && { description: group.description }),
    ...(group.picture && { picture: group.picture }),
    ...(group.secret && { secret: group.secret }),
    accepted: group.accepted
  }
  saveGroupToDb(storedGroup).catch(e => console.error('[groups] Failed to save group:', e))
}

export function createGroup(name: string, memberPubkeys: string[]): Group {
  const myPubkey = getPubkey()
  if (!myPubkey) throw new Error('Not logged in')

  const group = createGroupData(name, myPubkey, memberPubkeys)

  groups.update(g => {
    g.set(group.id, group)
    return g
  })
  groupMessages.update(gm => {
    gm.set(group.id, [])
    return gm
  })

  saveGroupState(group)

  fanOutToMembers(group.id, {
    content: buildGroupMetadataContent(group),
    kind: GROUP_METADATA_KIND,
    tags: []
  })

  setupGroupChannel(group)

  return group
}

export function addGroupMember(groupId: string, pubkey: string): void {
  const myPubkey = getPubkey()
  if (!myPubkey) return

  const group = get(groups).get(groupId)
  if (!group) return

  // Verify we have a chat session with the new member
  if (!get(chats).has(pubkey)) return

  const updated = libAddMember(group, pubkey, myPubkey)
  if (!updated) return

  groups.update(g => { g.set(groupId, updated); return g })
  saveGroupState(updated)

  teardownGroupChannel(groupId)
  setupGroupChannel(updated)

  fanOutToMembers(groupId, {
    content: buildGroupMetadataContent(updated),
    kind: GROUP_METADATA_KIND,
    tags: []
  }, updated.members)
}

export function removeGroupMember(groupId: string, pubkey: string): void {
  const myPubkey = getPubkey()
  if (!myPubkey) return

  const group = get(groups).get(groupId)
  if (!group) return

  const updated = libRemoveMember(group, pubkey, myPubkey)
  if (!updated) return

  groups.update(g => { g.set(groupId, updated); return g })
  saveGroupState(updated)

  teardownGroupChannel(groupId)
  setupGroupChannel(updated)

  // Remaining members get new secret
  fanOutToMembers(groupId, {
    content: buildGroupMetadataContent(updated),
    kind: GROUP_METADATA_KIND,
    tags: []
  }, updated.members)

  // Removed member gets metadata WITHOUT secret
  fanOutToMembers(groupId, {
    content: buildGroupMetadataContent(updated, { excludeSecret: true }),
    kind: GROUP_METADATA_KIND,
    tags: []
  }, [pubkey])
}

export function updateGroupInfo(groupId: string, updates: { name?: string, description?: string, picture?: string }): void {
  const myPubkey = getPubkey()
  if (!myPubkey) return

  const group = get(groups).get(groupId)
  if (!group) return

  const updated = updateGroupData(group, updates, myPubkey)
  if (!updated) return

  groups.update(g => { g.set(groupId, updated); return g })
  saveGroupState(updated)

  fanOutToMembers(groupId, {
    content: buildGroupMetadataContent(updated),
    kind: GROUP_METADATA_KIND,
    tags: []
  })
}

export function addGroupAdmin(groupId: string, pubkey: string): void {
  const myPubkey = getPubkey()
  if (!myPubkey) return

  const group = get(groups).get(groupId)
  if (!group) return

  const updated = libAddAdmin(group, pubkey, myPubkey)
  if (!updated) return

  groups.update(g => { g.set(groupId, updated); return g })
  saveGroupState(updated)

  fanOutToMembers(groupId, {
    content: buildGroupMetadataContent(updated),
    kind: GROUP_METADATA_KIND,
    tags: []
  })
}

export function removeGroupAdmin(groupId: string, pubkey: string): void {
  const myPubkey = getPubkey()
  if (!myPubkey) return

  const group = get(groups).get(groupId)
  if (!group) return

  const updated = libRemoveAdmin(group, pubkey, myPubkey)
  if (!updated) return

  groups.update(g => { g.set(groupId, updated); return g })
  saveGroupState(updated)

  fanOutToMembers(groupId, {
    content: buildGroupMetadataContent(updated),
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

export function handleGroupEvent(rumor: Rumor, senderPubkey: string, _outerEvent?: OuterEvent): void {
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
  const metadata = parseGroupMetadata(rumor.content)
  if (!metadata) return

  const myPubkey = getPubkey()
  if (!myPubkey) return

  const existing = get(groups).get(metadata.id)

  if (existing) {
    const result = validateMetadataUpdate(existing, metadata, senderPubkey, myPubkey)
    if (result === 'reject') {
      console.warn('[groups] Rejected metadata update from non-admin:', senderPubkey.slice(0, 8))
      return
    }
    if (result === 'removed') {
      deleteGroup(metadata.id)
      return
    }

    const secretChanged = metadata.secret && metadata.secret !== existing.secret
    const updated = applyMetadataUpdate(existing, metadata)

    groups.update(g => { g.set(metadata.id, updated); return g })
    saveGroupState(updated)

    if (secretChanged && updated.accepted) {
      teardownGroupChannel(metadata.id)
      setupGroupChannel(updated)
    }
  } else {
    if (!validateMetadataCreation(metadata, senderPubkey, myPubkey)) return

    const group: Group = {
      id: metadata.id,
      name: metadata.name,
      members: metadata.members,
      admins: metadata.admins,
      description: metadata.description,
      picture: metadata.picture,
      createdAt: rumor.created_at * 1000,
      secret: metadata.secret,
      accepted: false
    }

    groups.update(g => { g.set(metadata.id, group); return g })
    groupMessages.update(gm => { if (!gm.has(metadata.id)) gm.set(metadata.id, []); return gm })
    saveGroupState(group)

    console.log('[groups] Received group invitation:', metadata.name, 'from', senderPubkey.slice(0, 8))
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
  const parsed = parseReaction(rumor)
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
        createdAt: stored.createdAt,
        secret: stored.secret,
        accepted: stored.accepted
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

      // Only setup shared channel for accepted groups with a secret
      if (group.accepted && group.secret) {
        setupGroupChannel(group)
      }
    }
  } catch (e) {
    console.error('[groups] Failed to load groups from storage:', e)
  }
}

export async function deleteGroup(groupId: string): Promise<void> {
  teardownGroupChannel(groupId)

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

export function acceptGroupInvitation(groupId: string): void {
  const currentGroups = get(groups)
  const group = currentGroups.get(groupId)
  if (!group) return

  const updated: Group = { ...group, accepted: true }

  groups.update(g => {
    g.set(groupId, updated)
    return g
  })
  saveGroupState(updated)

  if (updated.secret) {
    setupGroupChannel(updated)
  }
}

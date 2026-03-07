import { writable, get } from 'svelte/store'
import {
  CHAT_MESSAGE_KIND, REACTION_KIND, TYPING_KIND, parseReaction,
  GROUP_METADATA_KIND,
  GROUP_SENDER_KEY_DISTRIBUTION_KIND,
  GroupManager,
  type GroupData,
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
  getExpirationTimestampSeconds,
} from 'nostr-double-ratchet'
import type { Rumor, NostrSubscribe, GroupDecryptedEvent } from 'nostr-double-ratchet'
import type { NDKEvent } from '@nostr-dev-kit/ndk'
import { getPubkey, ndk } from './identity'
import { devices } from './devices'
import { chats, type ChatMessage } from './chat'
import { getSessionManager } from './privateChats'
import { DexieStorageAdapter } from './sessionManagerStorage'
import { getEventHash, type Event as NostrEvent } from 'nostr-tools'
import {
  saveGroup as saveGroupToDb,
  getAllGroups,
  deleteGroupFromDb,
  saveMessage as saveMessageToDb,
  getMessagesForSession,
  deleteMessagesForSession,
  updateMessageStatus as updateMessageStatusInDb,
  type StoredGroup,
  type StoredMessage
} from './storage'
import { setRemoteTyping, clearRemoteTyping } from './typingState'
import { setupGroupChannel, teardownGroupChannel } from './groupChannels'
import { expirationStore } from './expirationStore'

export { GROUP_METADATA_KIND }
export type Group = GroupData

type OuterEvent = NostrEvent

export interface GroupMessage extends ChatMessage {
  senderPubkey?: string
}

export const groups = writable<Map<string, Group>>(new Map())
export const groupMessages = writable<Map<string, GroupMessage[]>>(new Map())
export const currentGroupId = writable<string | null>(null)

// Queue for group events that arrive before the group's metadata
// (e.g., message arrives before creation event due to network reordering)
const pendingGroupEvents = new Map<string, Array<{ rumor: Rumor, senderPubkey: string, senderDevicePubkey?: string }>>()
const MAX_PENDING_PER_GROUP = 50
const PENDING_MAX_AGE_MS = 5 * 60 * 1000 // 5 minutes

type NativeGroupRuntime = {
  manager: GroupManager
  ownerPubkey: string
  devicePubkey: string
}

let nativeGroupRuntime: NativeGroupRuntime | null = null
const nativeGroupStorage = new DexieStorageAdapter()

function queuePendingEvent(groupId: string, rumor: Rumor, senderPubkey: string, senderDevicePubkey?: string): void {
  let queue = pendingGroupEvents.get(groupId)
  if (!queue) {
    queue = []
    pendingGroupEvents.set(groupId, queue)
  }
  if (queue.length < MAX_PENDING_PER_GROUP) {
    queue.push({ rumor, senderPubkey, senderDevicePubkey })
  }
}

function flushPendingEvents(groupId: string): void {
  const queue = pendingGroupEvents.get(groupId)
  if (!queue || queue.length === 0) return
  pendingGroupEvents.delete(groupId)

  const now = Date.now()
  for (const { rumor, senderPubkey, senderDevicePubkey } of queue) {
    // Skip stale events
    if (now - rumor.created_at * 1000 > PENDING_MAX_AGE_MS) continue
    // Re-dispatch through handleGroupEvent (group now exists in store)
    handleGroupEvent(rumor, senderPubkey, undefined, senderDevicePubkey)
  }
}

function resolveOurDevicePubkey(): string | null {
  const devicePubkey = get(devices).identityPubkey?.trim()
  if (devicePubkey) return devicePubkey
  const ownerPubkey = getPubkey()?.trim()
  return ownerPubkey || null
}

function resolveNativeSenderPubkey(
  event: GroupDecryptedEvent,
  ownerPubkey: string,
  devicePubkey: string,
): string {
  const eventWithOrigin = event as GroupDecryptedEvent & {
    origin?: string
    isSelf?: boolean
  }

  if (typeof eventWithOrigin.isSelf === 'boolean') {
    return eventWithOrigin.isSelf
      ? ownerPubkey
      : (event.senderOwnerPubkey || event.senderDevicePubkey)
  }

  if (
    eventWithOrigin.origin === 'local-device' ||
    eventWithOrigin.origin === 'same-owner-other-device'
  ) {
    return ownerPubkey
  }

  if (event.senderOwnerPubkey) {
    return event.senderOwnerPubkey === ownerPubkey
      ? ownerPubkey
      : event.senderOwnerPubkey
  }

  if (event.senderDevicePubkey === devicePubkey) return ownerPubkey
  return event.senderDevicePubkey
}

function createNativeGroupSubscribe(): NostrSubscribe | undefined {
  const ndkInstance = get(ndk) as { subscribe?: (...args: unknown[]) => unknown } | undefined
  const subscribe = ndkInstance?.subscribe
  if (typeof subscribe !== 'function') return undefined

  return (filter, onEvent) => {
    const subscription = subscribe(
      filter,
      { closeOnEose: false },
    ) as {
      on?: (name: 'event', cb: (event: NDKEvent) => void) => void
      off?: (name: 'event', cb: (event: NDKEvent) => void) => void
      start?: () => void
      stop?: () => void
    }

    const onNdkEvent = (event: NDKEvent): void => {
      const rawEvent = event.rawEvent?.() as Parameters<typeof onEvent>[0] | undefined
      if (!rawEvent) return
      onEvent(rawEvent)
    }

    subscription.on?.('event', onNdkEvent)
    subscription.start?.()

    return () => {
      subscription.off?.('event', onNdkEvent)
      subscription.stop?.()
    }
  }
}

function teardownNativeGroupManager(): void {
  if (!nativeGroupRuntime) return
  try {
    nativeGroupRuntime.manager.destroy()
  } catch {
    // Ignore best-effort teardown failures.
  }
  nativeGroupRuntime = null
}

function ensureNativeGroupRuntime(): NativeGroupRuntime | null {
  const ownerPubkey = getPubkey()?.trim()
  const devicePubkey = resolveOurDevicePubkey()
  if (!ownerPubkey || !devicePubkey) return null

  const existing = nativeGroupRuntime
  if (
    existing &&
    existing.ownerPubkey === ownerPubkey &&
    existing.devicePubkey === devicePubkey
  ) {
    return existing
  }

  if (existing) {
    teardownNativeGroupManager()
  }

  const nostrSubscribe = createNativeGroupSubscribe()

  const runtime: NativeGroupRuntime = {
    manager: new GroupManager({
      ourOwnerPubkey: ownerPubkey,
      ourDevicePubkey: devicePubkey,
      storage: nativeGroupStorage,
      ...(nostrSubscribe ? { nostrSubscribe } : {}),
      onDecryptedEvent: (event) => {
        const senderPubkey = resolveNativeSenderPubkey(
          event,
          ownerPubkey,
          devicePubkey,
        )
        handleGroupEvent(
          event.inner,
          senderPubkey,
          undefined,
          event.senderDevicePubkey,
        )
      },
    }),
    ownerPubkey,
    devicePubkey,
  }

  nativeGroupRuntime = runtime
  return runtime
}

function teardownNativeGroupRuntime(groupId: string): void {
  nativeGroupRuntime?.manager.removeGroup(groupId)
}

async function processSenderKeyDistribution(
  groupId: string,
  rumor: Rumor,
  senderOwnerPubkey: string,
  senderDevicePubkey?: string,
): Promise<void> {
  const runtime = ensureNativeGroupRuntime()
  if (!runtime) return
  const groupData = get(groups).get(groupId)
  if (!groupData) return

  await runtime.manager.upsertGroup(groupData).catch(() => {})

  const resolvedSenderDevice = senderDevicePubkey || rumor.pubkey
  await runtime.manager.handleIncomingSessionEvent(
    rumor,
    senderOwnerPubkey,
    resolvedSenderDevice,
  )
}

function syncNativeGroupTransport(groupId: string): void {
  const runtime = ensureNativeGroupRuntime()
  if (!runtime) return

  const groupData = get(groups).get(groupId)
  if (!groupData) {
    runtime.manager.removeGroup(groupId)
    return
  }

  void runtime.manager.upsertGroup(groupData).catch(() => {})
}

export const isAdmin = isGroupAdmin

function buildGroupRumor(
  recipientPubkey: string,
  partialEvent: { content: string; kind: number; tags: string[][] }
): Rumor {
  const myPubkey = getPubkey()
  if (!myPubkey) {
    throw new Error('Not logged in')
  }

  const now = Date.now()
  const tags = [...partialEvent.tags]
  if (!tags.some((t) => t[0] === 'p' && t[1] === recipientPubkey)) {
    tags.unshift(['p', recipientPubkey])
  }
  if (!tags.some((t) => t[0] === 'ms')) {
    tags.push(['ms', String(now)])
  }

  const rumor: Rumor = {
    content: partialEvent.content,
    kind: partialEvent.kind,
    created_at: Math.floor(now / 1000),
    tags,
    pubkey: myPubkey,
    id: '',
  }
  rumor.id = getEventHash(rumor)
  return rumor
}

function fanOutToMembers(
  groupId: string,
  partialEvent: { content: string, kind: number, tags: string[][] },
  recipientOverride?: string[],
  options?: { includeSelf?: boolean },
): void {
  const currentGroups = get(groups)
  const group = currentGroups.get(groupId)
  if (!group) return

  const myPubkey = getPubkey()
  if (!myPubkey) return

  const manager = getSessionManager()
  if (!manager) return

  const tags = [...partialEvent.tags, ['l', groupId], ['ms', Date.now().toString()]]
  const recipients = recipientOverride || group.members
  const includeSelf = options?.includeSelf === true

  for (const memberPubkey of recipients) {
    if (!includeSelf && memberPubkey === myPubkey) continue

    try {
      const rumor = buildGroupRumor(memberPubkey, { ...partialEvent, tags })
      manager.sendEvent(memberPubkey, rumor).catch(() => {})
    } catch (e) {
      console.error('[groups] Failed to send to member:', memberPubkey.slice(0, 8), e)
    }
  }
}

function senderCopyGroupMetadataToSelf(groupId: string, content: string): void {
  const myPubkey = getPubkey()
  if (!myPubkey) return
  if (!getSessionManager()) return

  fanOutToMembers(
    groupId,
    {
      content,
      kind: GROUP_METADATA_KIND,
      tags: [],
    },
    [myPubkey],
    { includeSelf: true },
  )
}

function fanOutGroupMetadataToMembers(
  groupId: string,
  content: string,
  recipientOverride?: string[],
): void {
  fanOutToMembers(
    groupId,
    {
      content,
      kind: GROUP_METADATA_KIND,
      tags: [],
    },
    recipientOverride,
  )
  senderCopyGroupMetadataToSelf(groupId, content)
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

export async function createGroup(name: string, memberPubkeys: string[]): Promise<Group> {
  const myPubkey = getPubkey()
  if (!myPubkey) throw new Error('Not logged in')

  const runtime = ensureNativeGroupRuntime()
  const sessionManager = getSessionManager()
  const group = runtime
    ? (
        await runtime.manager.createGroup(name, memberPubkeys, {
          fanoutMetadata: Boolean(sessionManager),
          ...(sessionManager
            ? {
                sendPairwise: async (recipientOwnerPubkey, rumor) => {
                  await sessionManager.sendEvent(recipientOwnerPubkey, rumor)
                },
              }
            : {}),
        })
      ).group
    : createGroupData(name, myPubkey, memberPubkeys)

  groups.update(g => {
    g.set(group.id, group)
    return g
  })
  groupMessages.update(gm => {
    gm.set(group.id, [])
    return gm
  })

  saveGroupState(group)

  const metadataContent = buildGroupMetadataContent(group)

  if (!runtime) {
    fanOutGroupMetadataToMembers(group.id, metadataContent)
  } else {
    senderCopyGroupMetadataToSelf(group.id, metadataContent)
  }

  setupGroupChannel(group)
  syncNativeGroupTransport(group.id)

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

  fanOutGroupMetadataToMembers(
    groupId,
    buildGroupMetadataContent(updated),
    updated.members,
  )
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
  fanOutGroupMetadataToMembers(
    groupId,
    buildGroupMetadataContent(updated),
    updated.members,
  )

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

  fanOutGroupMetadataToMembers(groupId, buildGroupMetadataContent(updated))
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

  fanOutGroupMetadataToMembers(groupId, buildGroupMetadataContent(updated))
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

  fanOutGroupMetadataToMembers(groupId, buildGroupMetadataContent(updated))
}

export function sendGroupMessage(groupId: string, text: string, replyTo?: string): void {
  const myPubkey = getPubkey()
  if (!myPubkey) return

  const tags: string[][] = []
  if (replyTo) {
    tags.push(['e', replyTo, '', 'reply'])
  }

  const configuredTtlSeconds = expirationStore.getExpiration(groupId)
  const normalizedTtlSeconds =
    typeof configuredTtlSeconds === 'number' &&
    Number.isFinite(configuredTtlSeconds) &&
    configuredTtlSeconds > 0
      ? Math.floor(configuredTtlSeconds)
      : undefined
  const expiresAt =
    normalizedTtlSeconds !== undefined
      ? Math.floor(Date.now() / 1000) + normalizedTtlSeconds
      : undefined

  if (expiresAt !== undefined) {
    tags.push(['expiration', String(expiresAt)])
  }

  const message: GroupMessage = {
    id: crypto.randomUUID(),
    content: text,
    timestamp: Date.now(),
    isMine: true,
    senderPubkey: myPubkey,
    ...(replyTo && { replyTo }),
    ...(expiresAt !== undefined && { expiresAt }),
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
  }, undefined, { includeSelf: true })
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

export function handleGroupEvent(
  rumor: Rumor,
  senderPubkey: string,
  _outerEvent?: OuterEvent,
  senderDevicePubkey?: string
): void {
  const groupTag = rumor.tags?.find((t: string[]) => t[0] === 'l')
  if (!groupTag) return
  const groupId = groupTag[1]

  if (rumor.kind === GROUP_METADATA_KIND) {
    handleGroupMetadata(rumor, senderPubkey)
    return
  }

  const groupExists = get(groups).has(groupId)

  if (rumor.kind === GROUP_SENDER_KEY_DISTRIBUTION_KIND) {
    if (!groupExists) {
      // Queue event — metadata may arrive later (network reordering)
      queuePendingEvent(groupId, rumor, senderPubkey, senderDevicePubkey)
      return
    }
    void processSenderKeyDistribution(groupId, rumor, senderPubkey, senderDevicePubkey)
    return
  }

  if (!groupExists) {
    // Queue event — metadata may arrive later (network reordering)
    if (rumor.kind === CHAT_MESSAGE_KIND || rumor.kind === REACTION_KIND) {
      queuePendingEvent(groupId, rumor, senderPubkey, senderDevicePubkey)
    }
    return
  }

  if (rumor.kind === TYPING_KIND) {
    const expiresAt = getExpirationTimestampSeconds(rumor)
    const nowSeconds = Math.floor(Date.now() / 1000)
    if (expiresAt !== undefined && expiresAt <= nowSeconds) {
      clearRemoteTyping(`group:${groupId}`)
    } else {
      setRemoteTyping(`group:${groupId}`, rumor.created_at)
    }
    return
  }

  if (rumor.kind === REACTION_KIND) {
    handleGroupReaction(groupId, rumor, senderPubkey)
    return
  }

  if (rumor.kind === CHAT_MESSAGE_KIND) {
    const myPubkey = getPubkey()
    if (!myPubkey || senderPubkey !== myPubkey) {
      clearRemoteTyping(`group:${groupId}`, rumor.created_at)
    }
    handleGroupMessage(groupId, rumor, senderPubkey, senderDevicePubkey)
    return
  }
}

export function fanOutGroupMetadata(groupId: string, content: string): void {
  fanOutGroupMetadataToMembers(groupId, content)
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

    // Sync messageTtlSeconds from group metadata
    try {
      const raw = JSON.parse(rumor.content) as Record<string, unknown>
      if ('messageTtlSeconds' in raw) {
        const ttl = raw.messageTtlSeconds
        if (ttl === null || ttl === undefined) {
          expirationStore.setExpiration(metadata.id, null)
        } else if (typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0) {
          expirationStore.setExpiration(metadata.id, Math.floor(ttl))
        }
      }
    } catch {
      // ignore parse errors
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
    syncNativeGroupTransport(metadata.id)

    console.log('[groups] Received group invitation:', metadata.name, 'from', senderPubkey.slice(0, 8))

    // Flush any messages that arrived before this metadata
    flushPendingEvents(metadata.id)
  }
}

function handleGroupMessage(
  groupId: string,
  rumor: Rumor,
  senderPubkey: string,
  senderDevicePubkey?: string,
): void {
  const myPubkey = getPubkey()
  const isOwnOwnerMessage = !!myPubkey && senderPubkey === myPubkey
  if (isOwnOwnerMessage) {
    const ourDevicePubkey = resolveOurDevicePubkey()
    const resolvedSenderDevicePubkey = senderDevicePubkey || rumor.pubkey
    if (ourDevicePubkey && resolvedSenderDevicePubkey === ourDevicePubkey) {
      return
    }
  }

  const replyTag = rumor.tags?.find(
    (tag: string[]) => tag[0] === 'e' && tag[3] === 'reply'
  )?.[1] || rumor.tags?.find(
    (tag: string[]) => tag[0] === 'e' && !rumor.tags?.some((t: string[]) => t[0] === 'e' && t[3] === 'root')
  )?.[1]

  const expiresAt = getExpirationTimestampSeconds(rumor)

  const message: GroupMessage = {
    id: rumor.id,
    content: rumor.content,
    timestamp: rumor.created_at * 1000,
    isMine: isOwnOwnerMessage,
    senderPubkey,
    ...(replyTag && { replyTo: replyTag }),
    ...(expiresAt !== undefined && { expiresAt }),
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
      status: message.status,
      senderPubkey: message.senderPubkey,
      ...(message.expiresAt !== undefined && { expiresAt: message.expiresAt }),
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
          reactions: m.reactions,
          status: m.status,
          ...(m.expiresAt !== undefined && { expiresAt: m.expiresAt }),
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
      syncNativeGroupTransport(group.id)

      // Flush any events that arrived before this group was loaded
      flushPendingEvents(group.id)
    }
  } catch (e) {
    console.error('[groups] Failed to load groups from storage:', e)
  }
}

// Mark incoming group messages as seen locally (used for unread indicators).
export function markGroupMessagesSeen(groupId: string, messageIds: string[]): void {
  if (messageIds.length === 0) return
  const idSet = new Set(messageIds)

  groupMessages.update((gm) => {
    const msgs = gm.get(groupId) || []
    if (msgs.length === 0) return gm

    let changed = false
    const updated = msgs.map((m) => {
      if (!m.isMine && idSet.has(m.id) && m.status !== 'seen') {
        changed = true
        // Persist status for local unread tracking (no receipts for groups).
        updateMessageStatusInDb(m.id, 'seen')
        return { ...m, status: 'seen' as const }
      }
      return m
    })

    if (!changed) return gm
    gm.set(groupId, updated)
    return gm
  })
}

export async function deleteGroup(groupId: string): Promise<void> {
  teardownGroupChannel(groupId)
  teardownNativeGroupRuntime(groupId)

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
  syncNativeGroupTransport(groupId)
}

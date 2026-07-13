import { writable, get } from 'svelte/store'
import {
  buildGroupRosterFactEvent,
  buildGroupRosterFactFilter,
  CHAT_MESSAGE_KIND, CHAT_SETTINGS_KIND, REACTION_KIND, RECEIPT_KIND, TYPING_KIND, parseReaction,
  GROUP_ROSTER_FACT_KIND,
  GROUP_ROSTER_FACT_TYPE,
  GROUP_SENDER_KEY_DISTRIBUTION_KIND,
  isGroupRosterFactEvent,
  parseGroupRosterFactEvent,
  parseGroupRosterFactRumor,
  type GroupData,
  type GroupMetadata,
  type GroupRosterFact,
  type GroupRosterFactRumor,
  isGroupAdmin,
  createGroupData,
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
import type { Rumor } from 'nostr-double-ratchet'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getPubkey, identity, ndk } from './identity'
import { devices } from './devices'
import { chats, type ChatMessage, type RecipientDeliveryStatus } from './chat'
import {
  ensureDeviceRegistered,
  getNdrRuntime,
  waitForSendReadyRuntime,
} from './privateChats'
import { getEventHash, type VerifiedEvent } from 'nostr-tools'
import {
  saveGroup as saveGroupToDb,
  getAllGroups,
  deleteGroupFromDb,
  saveMessage as saveMessageToDb,
  getMessagesForSession,
  deleteMessage as deleteMessageFromDb,
  deleteMessagesForSession,
  updateMessageStatus as updateMessageStatusInDb,
  updateMessageSentToRelays as updateMessageSentToRelaysInDb,
  updateMessageRecipientStatuses as updateMessageRecipientStatusesInDb,
  updateMessageDeliveryTrace as updateMessageDeliveryTraceInDb,
  type StoredGroup,
  type StoredMessage
} from './storage'
import { asNdkEventSubscription } from './ndkSubscription'
import { setRemoteTyping, clearRemoteTyping } from './typingState'
import { expirationStore } from './expirationStore'
import { onMessageRelayPublish } from './messageRelayStatus'
import { parseReceipt, shouldAdvanceStatus, type MessageStatus, type ReceiptPayload } from './receipts'
import { receiptSettings } from './receiptSettings'
import { parseChatSettingsContent } from './chatSettings'

export { GROUP_ROSTER_FACT_KIND, GROUP_ROSTER_FACT_TYPE }
export type Group = GroupData

type OuterEvent = { id?: string; outerEventId?: string } | unknown
type NativeGroupSendResult = { outer: VerifiedEvent; inner: Rumor }
type GroupRosterFactCursor = Pick<GroupRosterFact, 'revision' | 'updatedAt' | 'eventCreatedAt' | 'eventId'>

export interface GroupMessage extends ChatMessage {
  senderPubkey?: string
}

export const groups = writable<Map<string, Group>>(new Map())
export const groupMessages = writable<Map<string, GroupMessage[]>>(new Map())
export const currentGroupId = writable<string | null>(null)

// Queue for group events that arrive before the group's roster snapshot
// (e.g., message arrives before creation event due to network reordering)
const pendingGroupEvents = new Map<string, Array<{ rumor: Rumor, senderPubkey: string, senderDevicePubkey?: string, outerEventId?: string }>>()
const MAX_PENDING_PER_GROUP = 50
const PENDING_MAX_AGE_MS = 5 * 60 * 1000 // 5 minutes
const nativeGroupSendQueue = new Map<string, Promise<void>>()
const groupRosterFactCursors = new Map<string, GroupRosterFactCursor>()
const seenGroupRosterFactIds = new Set<string>()
let groupRosterFactSyncCleanup: (() => void) | null = null
let groupRosterFactSyncOwner: string | null = null

function enqueueNativeGroupSend<T>(groupId: string, action: () => Promise<T>): Promise<T> {
  const previous = nativeGroupSendQueue.get(groupId) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(action)
  const settled = result.then(
    () => undefined,
    () => undefined,
  )
  nativeGroupSendQueue.set(groupId, settled)
  settled.finally(() => {
    if (nativeGroupSendQueue.get(groupId) === settled) {
      nativeGroupSendQueue.delete(groupId)
    }
  })
  return result
}

function queuePendingEvent(
  groupId: string,
  rumor: Rumor,
  senderPubkey: string,
  senderDevicePubkey?: string,
  outerEventId?: string,
): void {
  let queue = pendingGroupEvents.get(groupId)
  if (!queue) {
    queue = []
    pendingGroupEvents.set(groupId, queue)
  }
  if (queue.length < MAX_PENDING_PER_GROUP) {
    queue.push({ rumor, senderPubkey, senderDevicePubkey, outerEventId })
  }
}

function flushPendingEvents(groupId: string): void {
  const queue = pendingGroupEvents.get(groupId)
  if (!queue || queue.length === 0) return
  pendingGroupEvents.delete(groupId)

  const now = Date.now()
  for (const { rumor, senderPubkey, senderDevicePubkey, outerEventId } of queue) {
    // Skip stale events
    if (now - rumor.created_at * 1000 > PENDING_MAX_AGE_MS) continue
    // Re-dispatch through handleGroupEvent (group now exists in store)
    handleGroupEvent(rumor, senderPubkey, outerEventId ? { id: outerEventId } : undefined, senderDevicePubkey)
  }
}

function getOuterEventId(outerEvent: OuterEvent | undefined): string | undefined {
  if (!outerEvent || typeof outerEvent !== 'object') return undefined
  const candidate = outerEvent as { id?: unknown; outerEventId?: unknown }
  if (typeof candidate.id === 'string') return candidate.id
  if (typeof candidate.outerEventId === 'string') return candidate.outerEventId
  return undefined
}

function resolveOurDevicePubkey(): string | null {
  const devicePubkey = get(devices).identityPubkey?.trim()
  if (devicePubkey) return devicePubkey
  const ownerPubkey = getPubkey()?.trim()
  return ownerPubkey || null
}

export function syncNativeGroupTransport(groupId: string): void {
  const runtime = getNdrRuntime()
  const currentGroups = Array.from(get(groups).values())
  const ownerPubkey = getPubkey()?.trim()
  void runtime.syncGroups(currentGroups, ownerPubkey || undefined).catch((error) => {
    console.warn('[groups] Failed to sync runtime groups:', groupId, error)
  })
}

function isRuntimeSessionReady(): boolean {
  const runtime = getNdrRuntime()
  return typeof runtime.getState !== 'function' || runtime.getState().sessionManagerReady
}

export const isAdmin = isGroupAdmin

function compareGroupRosterFactCursor(
  left: GroupRosterFactCursor,
  right: GroupRosterFactCursor,
): number {
  return left.revision - right.revision
    || left.updatedAt - right.updatedAt
    || left.eventCreatedAt - right.eventCreatedAt
    || left.eventId.localeCompare(right.eventId)
}

function rememberGroupRosterFact(groupId: string, fact: GroupRosterFactCursor): void {
  const existing = groupRosterFactCursors.get(groupId)
  if (existing && compareGroupRosterFactCursor(existing, fact) >= 0) return
  groupRosterFactCursors.set(groupId, fact)
}

export function getGroupRosterVersion(groupId: string): { revision: number; updatedAt: number } | undefined {
  const fact = groupRosterFactCursors.get(groupId)
  return fact && { revision: fact.revision, updatedAt: fact.updatedAt }
}

export function rememberSyncedGroupRosterVersion(groupId: string, revision: number, updatedAt: number): void {
  rememberGroupRosterFact(groupId, { eventId: '', revision, updatedAt, eventCreatedAt: updatedAt })
}

function shouldApplyGroupRosterFact(fact: GroupRosterFact): boolean {
  if (seenGroupRosterFactIds.has(fact.eventId)) return false
  const existing = groupRosterFactCursors.get(fact.groupId)
  return !existing || compareGroupRosterFactCursor(fact, existing) > 0
}

function nextGroupRosterRevision(groupId: string): number {
  const previous = groupRosterFactCursors.get(groupId)?.revision ?? 0
  return previous + 1
}

function getGroupRosterSignerPubkey(group: Group): string | null {
  const currentIdentity = get(identity)
  const signer = get(ndk).signer || currentIdentity?.signer
  if (!signer) return null
  const signerPubkey = currentIdentity?.pubkey || (() => {
    try {
      return signer.pubkey
    } catch {
      return null
    }
  })()
  if (!signerPubkey || !group.admins.includes(signerPubkey)) return null
  return signerPubkey
}

async function publishGroupRosterFactSnapshot(group: Group): Promise<void> {
  const ndkInstance = get(ndk)
  const signer = ndkInstance.signer || get(identity)?.signer
  const signerPubkey = getGroupRosterSignerPubkey(group)
  if (!signer || !signerPubkey) return

  const eventCreatedAt = Math.floor(Date.now() / 1000)
  const unsigned = buildGroupRosterFactEvent(group, {
    signerPubkey,
    revision: nextGroupRosterRevision(group.id),
    createdBy: group.admins[0] || signerPubkey,
    updatedAt: eventCreatedAt,
    eventCreatedAt,
    protocol: group.secret ? 'sender_key_v1' : 'pairwise_fanout_v1',
  })

  const event = new NDKEvent(ndkInstance, unsigned)
  await event.sign(signer)
  const signed = event.rawEvent() as VerifiedEvent
  rememberGroupRosterFact(group.id, {
    eventId: signed.id,
    revision: Number(unsigned.tags.find((tag) => tag[0] === 'revision')?.[1] || 0),
    updatedAt: Number(unsigned.tags.find((tag) => tag[0] === 'updated_at')?.[1] || eventCreatedAt),
    eventCreatedAt: signed.created_at,
  })
  void event.publish(undefined, 10000, 1).catch((error) => {
    console.warn('[groups] Failed to publish group roster fact:', error)
  })
}

function publishGroupRosterFactSnapshotInBackground(group: Group): void {
  void publishGroupRosterFactSnapshot(group).catch((error) => {
    console.warn('[groups] Failed to publish group roster fact:', error)
  })
}

function groupMetadataFromRosterFact(fact: GroupRosterFact): GroupMetadata {
  return {
    id: fact.group.id,
    name: fact.group.name,
    members: fact.group.members,
    admins: fact.group.admins,
    ...(fact.group.description && { description: fact.group.description }),
    ...(fact.group.picture && { picture: fact.group.picture }),
  }
}

function applyGroupRosterFact(fact: GroupRosterFact): boolean {
  if (!shouldApplyGroupRosterFact(fact)) return false

  const myPubkey = getPubkey()
  if (!myPubkey) return false

  const metadata = groupMetadataFromRosterFact(fact)
  const existing = get(groups).get(fact.groupId)
  if (existing) {
    const result = validateMetadataUpdate(existing, metadata, fact.signerPubkey, myPubkey)
    if (result === 'reject') return false
    if (result === 'removed') {
      seenGroupRosterFactIds.add(fact.eventId)
      rememberGroupRosterFact(fact.groupId, fact)
      void deleteGroup(fact.groupId)
      return true
    }

    const updated = applyMetadataUpdate(existing, metadata)
    groups.update(g => { g.set(fact.groupId, updated); return g })
    saveGroupState(updated)
    syncNativeGroupTransport(fact.groupId)
  } else {
    if (!validateMetadataCreation(metadata, fact.signerPubkey, myPubkey)) return false

    const group: Group = {
      ...metadata,
      createdAt: fact.group.createdAt,
      accepted: fact.signerPubkey === myPubkey,
    }
    groups.update(g => { g.set(fact.groupId, group); return g })
    groupMessages.update(gm => { if (!gm.has(fact.groupId)) gm.set(fact.groupId, []); return gm })
    saveGroupState(group)
    syncNativeGroupTransport(fact.groupId)
    flushPendingEvents(fact.groupId)
  }

  seenGroupRosterFactIds.add(fact.eventId)
  rememberGroupRosterFact(fact.groupId, fact)
  return true
}

export function handleGroupRosterFactEvent(event: VerifiedEvent): boolean {
  if (!isGroupRosterFactEvent(event)) return false

  try {
    return applyGroupRosterFact(
      parseGroupRosterFactEvent(event as unknown as Parameters<typeof parseGroupRosterFactEvent>[0])
    )
  } catch {
    return false
  }
}

export function handleGroupRosterFactRumor(rumor: Rumor): boolean {
  if (!isGroupRosterFactEvent(rumor)) return false

  try {
    return applyGroupRosterFact(parseGroupRosterFactRumor(rumor as GroupRosterFactRumor))
  } catch {
    return false
  }
}

async function backfillGroupRosterFacts(): Promise<void> {
  const ndkInstance = get(ndk)
  if (typeof ndkInstance.fetchEvents !== 'function') return
  const events = await ndkInstance.fetchEvents(buildGroupRosterFactFilter({ limit: 200 }))
  for (const event of events) {
    const raw = typeof event.rawEvent === 'function' ? event.rawEvent() : event
    handleGroupRosterFactEvent(raw as VerifiedEvent)
  }
}

export function initGroupRosterFactSync(): () => void {
  const ownerPubkey = getPubkey()
  const ndkInstance = get(ndk)
  if (!ownerPubkey || typeof ndkInstance.subscribe !== 'function') {
    return () => {}
  }
  if (groupRosterFactSyncCleanup && groupRosterFactSyncOwner === ownerPubkey) {
    return groupRosterFactSyncCleanup
  }

  groupRosterFactSyncCleanup?.()
  const subscription = asNdkEventSubscription(
    ndkInstance.subscribe(buildGroupRosterFactFilter(), { closeOnEose: false })
  )
  subscription.on('event', (event: NDKEvent) => {
    handleGroupRosterFactEvent(event.rawEvent() as VerifiedEvent)
  })
  subscription.start()
  groupRosterFactSyncOwner = ownerPubkey
  groupRosterFactSyncCleanup = () => {
    subscription.stop()
    if (groupRosterFactSyncOwner === ownerPubkey) {
      groupRosterFactSyncCleanup = null
      groupRosterFactSyncOwner = null
    }
  }

  void backfillGroupRosterFacts().catch((error) => {
    console.warn('[groups] Failed to backfill group roster facts:', error)
  })

  return groupRosterFactSyncCleanup
}

function mergeRelayUrls(existing: string[] | undefined, next: string[]): string[] {
  return Array.from(
    new Set([...(existing || []), ...next].map((url) => url.trim()).filter(Boolean))
  ).sort()
}

function mergeStringList(existing: string[] | undefined, next: string[]): string[] {
  return Array.from(
    new Set([...(existing || []), ...next].map((value) => value.trim()).filter(Boolean))
  ).sort()
}

function relayChannelLabel(relayUrl: string): string {
  return `message server: ${relayUrl.trim()}`
}

function recipientStatusRank(status: RecipientDeliveryStatus | undefined): number {
  if (status === 'seen') return 3
  if (status === 'delivered') return 2
  if (status === 'sent') return 1
  return 0
}

function advanceRecipientStatus(
  existing: Record<string, RecipientDeliveryStatus> | undefined,
  pubkey: string,
  status: MessageStatus
): Record<string, RecipientDeliveryStatus> | null {
  const previous = existing?.[pubkey]
  if (recipientStatusRank(previous) >= recipientStatusRank(status)) return null
  return {
    ...(existing || {}),
    [pubkey]: status,
  }
}

function markGroupMessageSentToRelays(messageId: string, relayUrls: string[]): void {
  let relaysToPersist: string[] | null = null
  let channelsToPersist: string[] | null = null

  groupMessages.update((groupMap) => {
    for (const [groupId, messages] of groupMap) {
      const messageIndex = messages.findIndex((message) => message.id === messageId)
      if (messageIndex === -1) continue

      const message = messages[messageIndex]
      const sentToRelays = mergeRelayUrls(message.sentToRelays, relayUrls)
      const currentRelays = message.sentToRelays || []
      const deliveryChannels = mergeStringList(
        message.deliveryChannels,
        relayUrls.map(relayChannelLabel)
      )
      const currentChannels = message.deliveryChannels || []
      if (
        sentToRelays.length === currentRelays.length &&
        sentToRelays.every((url, index) => url === currentRelays[index]) &&
        deliveryChannels.length === currentChannels.length &&
        deliveryChannels.every((channel, index) => channel === currentChannels[index])
      ) {
        return groupMap
      }

      const updatedMessages = [...messages]
      updatedMessages[messageIndex] = { ...message, sentToRelays, deliveryChannels }
      relaysToPersist = sentToRelays
      channelsToPersist = deliveryChannels
      groupMap.set(groupId, updatedMessages)
      return groupMap
    }

    return groupMap
  })

  if (!relaysToPersist) return

  void updateMessageSentToRelaysInDb(messageId, relaysToPersist).catch((error) => {
    console.error('[groups] Failed to persist group relay publish status:', error)
  })
  if (channelsToPersist) {
    void updateMessageDeliveryTraceInDb(messageId, { deliveryChannels: channelsToPersist }).catch((error) => {
      console.error('[groups] Failed to persist group delivery channels:', error)
    })
  }
}

function reconcileLocalGroupMessageId(
  groupId: string,
  localMessageId: string,
  runtimeMessageId: string,
): void {
  if (!runtimeMessageId || runtimeMessageId === localMessageId) return

  let reconciledMessage: GroupMessage | null = null
  let shouldDeleteLocalMessage = false

  groupMessages.update((groupMap) => {
    const messages = groupMap.get(groupId)
    if (!messages) return groupMap

    const localIndex = messages.findIndex((message) => message.id === localMessageId)
    if (localIndex === -1) return groupMap

    const runtimeIndex = messages.findIndex((message) => message.id === runtimeMessageId)
    const updatedMessages = [...messages]
    const localMessage = updatedMessages[localIndex]
    if (!localMessage) return groupMap

    if (runtimeIndex !== -1) {
      updatedMessages.splice(localIndex, 1)
      shouldDeleteLocalMessage = true
    } else {
      reconciledMessage = { ...localMessage, id: runtimeMessageId }
      updatedMessages[localIndex] = reconciledMessage
      shouldDeleteLocalMessage = true
    }

    groupMap.set(groupId, updatedMessages)
    return groupMap
  })

  if (reconciledMessage) {
    void saveGroupMessageToStorage(groupId, reconciledMessage)
  }
  if (shouldDeleteLocalMessage) {
    void deleteMessageFromDb(localMessageId)
  }
}

onMessageRelayPublish(markGroupMessageSentToRelays)

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

function buildGroupRuntimeRumor(
  groupId: string,
  partialEvent: { content: string; kind: number; tags: string[][] }
): Rumor {
  const myPubkey = getPubkey()
  if (!myPubkey) {
    throw new Error('Not logged in')
  }

  const now = Date.now()
  const tags = [...partialEvent.tags]
  if (!tags.some((t) => t[0] === 'l')) {
    tags.unshift(['l', groupId])
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

function parseSerializedGroupRuntimeRumor(content: string): Rumor | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') return null
  const value = parsed as Record<string, unknown>
  if (
    typeof value.pubkey !== 'string' ||
    typeof value.kind !== 'number' ||
    typeof value.content !== 'string' ||
    typeof value.created_at !== 'number' ||
    !Array.isArray(value.tags)
  ) {
    return null
  }

  const tags = value.tags
    .filter((tag): tag is string[] =>
      Array.isArray(tag) && tag.every((part) => typeof part === 'string')
    )
    .map((tag) => [...tag])
  if (!tags.some((tag) => tag[0] === 'l' && typeof tag[1] === 'string')) {
    return null
  }

  const rumor: Rumor = {
    id: '',
    pubkey: value.pubkey,
    kind: value.kind,
    content: value.content,
    created_at: value.created_at,
    tags,
  }
  const computedId = getEventHash(rumor)
  if (typeof value.id === 'string' && value.id && value.id !== computedId) {
    return null
  }
  rumor.id = typeof value.id === 'string' && value.id ? value.id : computedId
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

  const tags = [...partialEvent.tags, ['l', groupId], ['ms', Date.now().toString()]]
  const recipients = recipientOverride || group.members
  const includeSelf = options?.includeSelf === true

  for (const memberPubkey of recipients) {
    if (!includeSelf && memberPubkey === myPubkey) continue

    try {
      const rumor = buildGroupRumor(memberPubkey, { ...partialEvent, tags })
      void ensureDeviceRegistered()
        .then(() => getNdrRuntime().sendEvent(memberPubkey, rumor))
        .catch((error) => {
          console.warn(
            '[groups] Failed to send to member:',
            memberPubkey.slice(0, 8),
            error,
          )
        })
    } catch (e) {
      console.error('[groups] Failed to send to member:', memberPubkey.slice(0, 8), e)
    }
  }
}

async function fanOutToOwnDevices(
  groupId: string,
  partialEvent: { content: string, kind: number, tags: string[][] },
): Promise<void> {
  const myPubkey = getPubkey()
  if (!myPubkey) return

  await ensureDeviceRegistered()
  const rumor = buildGroupRumor(myPubkey, {
    ...partialEvent,
    tags: [...partialEvent.tags, ['l', groupId], ['ms', Date.now().toString()]],
  })
  await getNdrRuntime().sendEvent(myPubkey, rumor)
}

async function sendNativeGroupEvent(
  groupId: string,
  partialEvent: { content: string, kind: number, tags: string[][] },
  options?: { includeSelfPairwiseCopy?: boolean },
): Promise<NativeGroupSendResult | null> {
  return enqueueNativeGroupSend(groupId, async () => {
    const runtime = getNdrRuntime()
    const groupData = get(groups).get(groupId)
    if (!groupData) {
      fanOutToMembers(
        groupId,
        partialEvent,
        undefined,
        options?.includeSelfPairwiseCopy ? { includeSelf: true } : undefined,
      )
      return null
    }

    await waitForSendReadyRuntime()
    await runtime.upsertGroup(groupData)
    try {
      const runtimeRumor = buildGroupRuntimeRumor(groupId, partialEvent)
      const result = await runtime.sendGroupEvent(groupId, {
        kind: runtimeRumor.kind,
        content: JSON.stringify(runtimeRumor),
        tags: runtimeRumor.tags,
      })

      if (options?.includeSelfPairwiseCopy) {
        await fanOutToOwnDevices(groupId, partialEvent)
      }
      return { outer: result.outer as unknown as VerifiedEvent, inner: runtimeRumor }
    } catch (error) {
      console.warn('[groups] Native group send failed, falling back to pairwise fanout:', error)
      fanOutToMembers(
        groupId,
        partialEvent,
        undefined,
        options?.includeSelfPairwiseCopy ? { includeSelf: true } : undefined,
      )
      return null
    }
  })
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

  let group = createGroupData(name, myPubkey, memberPubkeys)
  try {
    await waitForSendReadyRuntime()
    group = (
      await getNdrRuntime().createGroup(name, memberPubkeys, {
        fanoutMetadata: isRuntimeSessionReady(),
      })
    ).group
  } catch (error) {
    console.warn('[groups] Falling back to local-only group creation:', error)
  }

  groups.update(g => {
    g.set(group.id, group)
    return g
  })
  groupMessages.update(gm => {
    gm.set(group.id, [])
    return gm
  })

  saveGroupState(group)

  publishGroupRosterFactSnapshotInBackground(group)
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

  publishGroupRosterFactSnapshotInBackground(updated)
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

  publishGroupRosterFactSnapshotInBackground(updated)
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

  publishGroupRosterFactSnapshotInBackground(updated)
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

  publishGroupRosterFactSnapshotInBackground(updated)
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

  publishGroupRosterFactSnapshotInBackground(updated)
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

  void sendNativeGroupEvent(
    groupId,
    {
      content: text,
      kind: CHAT_MESSAGE_KIND,
      tags,
    },
    { includeSelfPairwiseCopy: true },
  )
    .then((result) => {
      if (result?.inner.id) {
        reconcileLocalGroupMessageId(groupId, message.id, result.inner.id)
      }
    })
    .catch((error) => {
      console.error('[groups] Failed to send group message:', error)
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

  void sendNativeGroupEvent(
    groupId,
    {
      content: JSON.stringify({ type: 'reaction', messageId, emoji }),
      kind: REACTION_KIND,
      tags: [['e', messageId]],
    },
    { includeSelfPairwiseCopy: true },
  ).catch((error) => {
    console.error('[groups] Failed to send group reaction:', error)
  })
}

export function sendGroupTypingEvent(groupId: string): void {
  void sendNativeGroupEvent(groupId, {
    content: 'typing',
    kind: TYPING_KIND,
    tags: [],
  }).catch((error) => {
    console.error('[groups] Failed to send group typing event:', error)
  })
}

export function sendGroupSettingsEvent(groupId: string, messageTtlSeconds: number | null): void {
  void sendNativeGroupEvent(
    groupId,
    {
      content: JSON.stringify({ type: 'chat-settings', v: 1, messageTtlSeconds }),
      kind: CHAT_SETTINGS_KIND,
      tags: [],
    },
    { includeSelfPairwiseCopy: true },
  ).catch((error) => {
    console.error('[groups] Failed to send group settings event:', error)
  })
}

export function handleGroupEvent(
  rumor: Rumor,
  senderPubkey: string,
  outerEvent?: OuterEvent,
  senderDevicePubkey?: string
): void {
  rumor = parseSerializedGroupRuntimeRumor(rumor.content) ?? rumor
  const groupTag = rumor.tags?.find((t: string[]) => t[0] === 'l')
  if (!groupTag) return
  const groupId = groupTag[1]
  const outerEventId = getOuterEventId(outerEvent)

  const groupExists = get(groups).has(groupId)

  if (rumor.kind === GROUP_SENDER_KEY_DISTRIBUTION_KIND) {
    if (!groupExists) {
      // Queue event; the roster snapshot may arrive later due to network reordering.
      queuePendingEvent(groupId, rumor, senderPubkey, senderDevicePubkey, outerEventId)
    }
    return
  }

  if (!groupExists) {
    // Queue event; the roster snapshot may arrive later due to network reordering.
    if (
      rumor.kind === CHAT_MESSAGE_KIND ||
      rumor.kind === REACTION_KIND ||
      rumor.kind === RECEIPT_KIND ||
      rumor.kind === CHAT_SETTINGS_KIND
    ) {
      queuePendingEvent(groupId, rumor, senderPubkey, senderDevicePubkey, outerEventId)
    }
    return
  }

  if (rumor.kind === CHAT_SETTINGS_KIND) {
    const group = get(groups).get(groupId)
    if (!group?.admins?.includes(senderPubkey)) return
    const settings = parseChatSettingsContent(rumor.content)
    if (settings) {
      expirationStore.setExpiration(groupId, settings.messageTtlSeconds)
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

  if (rumor.kind === RECEIPT_KIND) {
    const receipt = parseReceipt(rumor)
    if (receipt) {
      handleGroupReceipt(groupId, receipt, senderPubkey)
    }
    return
  }

  if (rumor.kind === CHAT_MESSAGE_KIND) {
    const myPubkey = getPubkey()
    if (!myPubkey || senderPubkey !== myPubkey) {
      clearRemoteTyping(`group:${groupId}`, rumor.created_at)
    }
    handleGroupMessage(groupId, rumor, senderPubkey, senderDevicePubkey, outerEventId)
    return
  }
}

function handleGroupMessage(
  groupId: string,
  rumor: Rumor,
  senderPubkey: string,
  senderDevicePubkey?: string,
  outerEventId?: string,
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
  const group = get(groups).get(groupId)
  const shouldAckDelivered =
    !isOwnOwnerMessage &&
    group?.accepted !== false &&
    get(receiptSettings).sendDeliveryReceipts

  const message: GroupMessage = {
    id: rumor.id,
    content: rumor.content,
    timestamp: rumor.created_at * 1000,
    isMine: isOwnOwnerMessage,
    senderPubkey,
    ...(replyTag && { replyTo: replyTag }),
    ...(shouldAckDelivered && { status: 'delivered' as const }),
    deliveryChannels: ['message servers'],
    outerEventIds: [outerEventId || rumor.id],
    ...(expiresAt !== undefined && { expiresAt }),
  }

  groupMessages.update(gm => {
    const msgs = gm.get(groupId) || []
    if (msgs.some(m => m.id === message.id)) return gm
    gm.set(groupId, [...msgs, message].sort((a, b) => a.timestamp - b.timestamp))
    return gm
  })

  saveGroupMessageToStorage(groupId, message)
  if (shouldAckDelivered) {
    sendGroupReceipt(groupId, 'delivered', [message.id])
  }
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

function handleGroupReceipt(groupId: string, receipt: ReceiptPayload, fromPubkey: string): void {
  const myPubkey = getPubkey()
  const changedStatuses: Array<{ messageId: string; status: MessageStatus }> = []
  const changedRecipientStatuses: Array<{
    messageId: string
    recipientStatuses: Record<string, RecipientDeliveryStatus>
  }> = []

  groupMessages.update((gm) => {
    const msgs = gm.get(groupId) || []
    if (msgs.length === 0) return gm

    const updated = [...msgs]
    let changed = false

    for (const messageId of receipt.messageIds) {
      const index = updated.findIndex((message) => message.id === messageId)
      if (index === -1) continue

      const message = updated[index]
      const nextRecipientStatuses =
        message.isMine && fromPubkey !== myPubkey
          ? advanceRecipientStatus(message.recipientStatuses, fromPubkey, receipt.type)
          : null
      const nextStatus =
        !message.isMine && fromPubkey === myPubkey && shouldAdvanceStatus(message.status, receipt.type)
          ? receipt.type
          : message.status
      if (!nextRecipientStatuses && nextStatus === message.status) continue

      updated[index] = {
        ...message,
        status: nextStatus,
        ...(nextRecipientStatuses && { recipientStatuses: nextRecipientStatuses }),
      }
      if (nextStatus && nextStatus !== message.status) {
        changedStatuses.push({ messageId, status: nextStatus })
      }
      if (nextRecipientStatuses) {
        changedRecipientStatuses.push({ messageId, recipientStatuses: nextRecipientStatuses })
      }
      changed = true
    }

    if (!changed) return gm
    gm.set(groupId, updated)
    return gm
  })

  for (const { messageId, status } of changedStatuses) {
    updateMessageStatusInDb(messageId, status)
  }
  for (const { messageId, recipientStatuses } of changedRecipientStatuses) {
    updateMessageRecipientStatusesInDb(messageId, recipientStatuses)
  }
}

function sendGroupReceipt(groupId: string, type: MessageStatus, messageIds: string[]): void {
  if (messageIds.length === 0) return
  void sendNativeGroupEvent(
    groupId,
    {
      content: type,
      kind: RECEIPT_KIND,
      tags: messageIds.map((messageId) => ['e', messageId]),
    },
    { includeSelfPairwiseCopy: true },
  ).catch((error) => {
    console.error('[groups] Failed to send group receipt:', error)
  })
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
      ...(message.sentToRelays && { sentToRelays: message.sentToRelays }),
      ...(message.recipientStatuses && { recipientStatuses: message.recipientStatuses }),
      ...(message.deliveryChannels && { deliveryChannels: message.deliveryChannels }),
      ...(message.outerEventIds && { outerEventIds: message.outerEventIds }),
      ...(message.pendingRelayEventIds && { pendingRelayEventIds: message.pendingRelayEventIds }),
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
          ...(m.sentToRelays && { sentToRelays: m.sentToRelays }),
          ...(m.recipientStatuses && { recipientStatuses: m.recipientStatuses }),
          ...(m.deliveryChannels && { deliveryChannels: m.deliveryChannels }),
          ...(m.outerEventIds && { outerEventIds: m.outerEventIds }),
          ...(m.pendingRelayEventIds && { pendingRelayEventIds: m.pendingRelayEventIds }),
          ...(m.expiresAt !== undefined && { expiresAt: m.expiresAt }),
        }))
        .sort((a, b) => a.timestamp - b.timestamp)

      groupMessages.update(gm => {
        gm.set(group.id, messages)
        return gm
      })

      syncNativeGroupTransport(group.id)

      // Flush any events that arrived before this group was loaded
      flushPendingEvents(group.id)
    }
    initGroupRosterFactSync()
  } catch (e) {
    console.error('[groups] Failed to load groups from storage:', e)
  }
}

// Mark incoming group messages as seen locally (used for unread indicators).
export function markGroupMessagesSeen(groupId: string, messageIds: string[]): void {
  if (messageIds.length === 0) return
  const idSet = new Set(messageIds)
  const toAck: string[] = []

  groupMessages.update((gm) => {
    const msgs = gm.get(groupId) || []
    if (msgs.length === 0) return gm

    let changed = false
    const updated = msgs.map((m) => {
      if (!m.isMine && idSet.has(m.id) && m.status !== 'seen') {
        changed = true
        toAck.push(m.id)
        updateMessageStatusInDb(m.id, 'seen')
        return { ...m, status: 'seen' as const }
      }
      return m
    })

    if (!changed) return gm
    gm.set(groupId, updated)
    return gm
  })

  const group = get(groups).get(groupId)
  if (toAck.length > 0 && group?.accepted !== false && get(receiptSettings).sendReadReceipts) {
    sendGroupReceipt(groupId, 'seen', toAck)
  }
}

export async function deleteGroup(groupId: string): Promise<void> {
  try {
    getNdrRuntime().removeGroup(groupId)
  } catch {
    // Ignore best-effort runtime cleanup failures.
  }

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

export function clearGroupData(): void {
  const groupIds = Array.from(get(groups).keys())
  for (const groupId of groupIds) {
    clearRemoteTyping(`group:${groupId}`)
  }

  void getNdrRuntime().syncGroups([]).catch(() => {})
  groupRosterFactSyncCleanup?.()
  groupRosterFactSyncCleanup = null
  groupRosterFactSyncOwner = null
  groupRosterFactCursors.clear()
  seenGroupRosterFactIds.clear()
  pendingGroupEvents.clear()
  groups.set(new Map())
  groupMessages.set(new Map())
  currentGroupId.set(null)
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

  syncNativeGroupTransport(groupId)
}

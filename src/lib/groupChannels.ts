import { writable, get } from 'svelte/store'
import {
  SharedChannel,
  Invite,
  SHARED_CHANNEL_KIND,
  type Rumor,
} from 'nostr-double-ratchet'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import type { NDKSubscription } from '@nostr-dev-kit/ndk'
import type { Filter } from 'nostr-tools'
import { ndk, getPubkey, hexToBytes } from './identity'
import { chats, acceptInvite } from './chat'
import type { Group } from './groups'
import {
  asNdkEventSubscription,
  type NdkEventSubscription,
} from './ndkSubscription'

const GROUP_INVITE_RUMOR_KIND = 10445

interface ChannelState {
  channel: SharedChannel
  subscription: NdkEventSubscription | null
  groupId: string
}

const activeChannels = new Map<string, ChannelState>()

// Track invites published per group: groupId -> Map<memberPubkey, inviteUrl>
export const groupInvites = writable<Map<string, Map<string, string>>>(new Map())

export function setupGroupChannel(group: Group): void {
  if (!group.secret || !group.accepted) return
  if (activeChannels.has(group.id)) return

  const myPubkey = getPubkey()
  if (!myPubkey) return

  const secretBytes = hexToBytes(group.secret)
  const channel = new SharedChannel(secretBytes)

  const state: ChannelState = {
    channel,
    subscription: null,
    groupId: group.id
  }
  activeChannels.set(group.id, state)

  // Subscribe to channel events on relay
  const ndkInstance = get(ndk)
  const filter: Filter = {
    kinds: [SHARED_CHANNEL_KIND as number],
    authors: [channel.publicKey]
  }

  const sub = asNdkEventSubscription(
    ndkInstance.subscribe(filter, { closeOnEose: false })
  )
  state.subscription = sub

  const seenIds = new Set<string>()
  sub.on('event', (ndkEvent: NDKEvent) => {
    const event = ndkEvent.rawEvent()
    if (seenIds.has(event.id)) return
    seenIds.add(event.id)

    try {
      if (!channel.isChannelEvent(event)) return
      const rumor = channel.decryptEvent(event)
      handleChannelRumor(group, rumor, myPubkey)
    } catch (e) {
      console.error('[groupChannels] Failed to decrypt channel event:', e)
    }
  })

  // Publish own invite on the channel
  publishOwnInvite(group, channel, myPubkey)
}

export function teardownGroupChannel(groupId: string): void {
  const state = activeChannels.get(groupId)
  if (!state) return

  state.subscription?.stop()
  activeChannels.delete(groupId)
}

function publishOwnInvite(group: Group, channel: SharedChannel, myPubkey: string): void {
  const invite = Invite.createNew(myPubkey)
  invite.ownerPubkey = myPubkey
  const inviteUrl = invite.getUrl()

  const rumor: Rumor = {
    id: crypto.randomUUID(),
    kind: GROUP_INVITE_RUMOR_KIND,
    content: JSON.stringify({ inviteUrl, groupId: group.id }),
    pubkey: myPubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: []
  }

  const event = channel.createEvent(rumor)

  const ndkInstance = get(ndk)
  const ndkPublishEvent = new NDKEvent(ndkInstance, event)
  ndkPublishEvent.publish().catch(e =>
    console.error('[groupChannels] Failed to publish invite on channel:', e)
  )
}

function handleChannelRumor(group: Group, rumor: Rumor, myPubkey: string): void {
  if (rumor.kind !== GROUP_INVITE_RUMOR_KIND) return

  const authorPubkey = rumor.pubkey
  // Skip own invites
  if (authorPubkey === myPubkey) return

  // Skip if not a group member
  if (!group.members.includes(authorPubkey)) return

  try {
    const data = JSON.parse(rumor.content) as { inviteUrl: string, groupId: string }
    if (data.groupId !== group.id) return

    // Track the invite
    groupInvites.update(gi => {
      let groupMap = gi.get(group.id)
      if (!groupMap) {
        groupMap = new Map()
        gi.set(group.id, groupMap)
      }
      groupMap.set(authorPubkey, data.inviteUrl)
      return gi
    })

    // Skip if we already have a session with this member
    const currentChats = get(chats)
    if (currentChats.has(authorPubkey)) return

    // Auto-accept the invite
    acceptGroupMemberInvite(data.inviteUrl, authorPubkey, group.id)
  } catch (e) {
    console.error('[groupChannels] Failed to parse channel rumor:', e)
  }
}

async function acceptGroupMemberInvite(inviteUrl: string, memberPubkey: string, groupId: string): Promise<void> {
  try {
    const invite = Invite.fromUrl(inviteUrl)
    if (!invite.ownerPubkey) {
      invite.ownerPubkey = memberPubkey
    }
    await acceptInvite({ type: 'legacy', invite })

    console.log('[groupChannels] Auto-accepted invite from group member:', memberPubkey.slice(0, 8), 'in group:', groupId.slice(0, 8))
  } catch (e) {
    console.error('[groupChannels] Failed to accept group member invite:', e)
  }
}

/** Check if a 1:1 session exists with a given pubkey */
export function hasSessionWith(pubkey: string): boolean {
  return get(chats).has(pubkey)
}

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'
import type { Rumor } from 'nostr-double-ratchet'
import { finalizeEvent, getPublicKey, type VerifiedEvent } from 'nostr-tools'

// --- Mocks ---

const MY_PUBKEY = 'aaaa'.repeat(16)
const MEMBER_B = 'bbbb'.repeat(16)
const MEMBER_C = 'cccc'.repeat(16)
const NON_MEMBER = 'dddd'.repeat(16)
const OTHER_DEVICE = 'eeee'.repeat(16)
const ROSTER_ADMIN_SECRET = new Uint8Array(32).fill(7)
const ROSTER_ADMIN = getPublicKey(ROSTER_ADMIN_SECRET)
const ROSTER_MEMBER_SECRET = new Uint8Array(32).fill(8)
const ROSTER_MEMBER = getPublicKey(ROSTER_MEMBER_SECRET)
const publishedGroupRosterFacts: Array<{ kind: number; content: string; tags: string[][]; pubkey: string; id: string; sig: string; created_at: number }> = []

vi.mock('@nostr-dev-kit/ndk', () => ({
  NDKEvent: class {
    private event: { kind: number; content: string; tags: string[][]; pubkey: string; id?: string; sig?: string; created_at?: number }

    constructor(_ndk: unknown, event: { kind: number; content: string; tags?: string[][]; pubkey?: string; created_at?: number }) {
      this.event = {
        kind: event.kind,
        content: event.content,
        tags: event.tags || [],
        pubkey: event.pubkey || MY_PUBKEY,
        created_at: event.created_at || Math.floor(Date.now() / 1000),
      }
    }

    async sign(signer: { pubkey?: string }): Promise<string> {
      this.event.pubkey = signer.pubkey || this.event.pubkey
      this.event.id = `fact-${publishedGroupRosterFacts.length + 1}`
      this.event.sig = 'sig'
      return this.event.sig
    }

    rawEvent() {
      return this.event
    }

    async publish(): Promise<Set<{ url: string }>> {
      publishedGroupRosterFacts.push(this.event as { kind: number; content: string; tags: string[][]; pubkey: string; id: string; sig: string; created_at: number })
      return new Set([{ url: 'wss://relay.test' }])
    }
  },
}))

vi.mock('./identity', () => {
  const { writable } = require('svelte/store')
  const signer = { pubkey: MY_PUBKEY }
  return {
    getPubkey: () => MY_PUBKEY,
    identity: writable({ pubkey: MY_PUBKEY, signer, displayName: null, isNip07: false }),
    ndk: writable({
      signer,
      subscribe: vi.fn(() => ({
        on: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      })),
      fetchEvents: vi.fn(async () => []),
    }),
    bytesToHex: (bytes: Uint8Array) => Array.from(bytes).map((b: number) => b.toString(16).padStart(2, '0')).join(''),
  }
})

// Track sendEvent calls per recipient
const sendEventCalls: Array<{ recipient: string, event: unknown }> = []
const sessionManagerValues = new Map<string, unknown>()
const runtimeGroups = new Map<string, {
  id: string
  name: string
  description: string
  picture: string
  members: string[]
  admins: string[]
  createdAt: number
  accepted: boolean
  secret: string
}>()

async function waitForRecipients(...recipients: string[]) {
  await vi.waitFor(() => {
    for (const recipient of recipients) {
      expect(sendEventCalls.some((call) => call.recipient === recipient)).toBe(true)
    }
  })
}

vi.mock('./chat', () => {
  const { writable } = require('svelte/store')
  const chatMap = new Map()
  chatMap.set(MEMBER_B, { id: MEMBER_B, recipientPubkey: MEMBER_B, messages: [], mode: 'manager' })
  chatMap.set(MEMBER_C, { id: MEMBER_C, recipientPubkey: MEMBER_C, messages: [], mode: 'manager' })
  chatMap.set(NON_MEMBER, { id: NON_MEMBER, recipientPubkey: NON_MEMBER, messages: [], mode: 'manager' })

  return {
    chats: writable(chatMap),
    ChatMessage: {},
    ChatSession: {},
  }
})

vi.mock('./privateChats', () => ({
  ensureDeviceRegistered: vi.fn().mockResolvedValue(undefined),
  getSessionManager: () => ({
    sendEvent: (recipient: string, event: unknown) => {
      sendEventCalls.push({ recipient, event })
      return Promise.resolve(undefined)
    },
  }),
  waitForPeerSendReadySessionManager: async () => ({
    sendEvent: (recipient: string, event: unknown) => {
      sendEventCalls.push({ recipient, event })
      return Promise.resolve(undefined)
    },
  }),
  waitForSendReadySessionManager: async () => ({
    sendEvent: (recipient: string, event: unknown) => {
      sendEventCalls.push({ recipient, event })
      return Promise.resolve(undefined)
    },
  }),
  waitForSendReadyRuntime: async () => ({
    sendEvent: (recipient: string, event: unknown) => {
      sendEventCalls.push({ recipient, event })
      return Promise.resolve(undefined)
    },
  }),
  getNdrRuntime: () => ({
    getState: () => ({ sessionManagerReady: true }),
    sendEvent: (recipient: string, event: unknown) => {
      sendEventCalls.push({ recipient, event })
      return Promise.resolve(undefined)
    },
    syncGroups: async (groups: Array<{
      id: string
      name: string
      description?: string
      picture?: string
      members: string[]
      admins: string[]
      createdAt: number
      accepted?: boolean
      secret?: string
    }>) => {
      runtimeGroups.clear()
      for (const group of groups) {
        runtimeGroups.set(group.id, {
          id: group.id,
          name: group.name,
          description: group.description || '',
          picture: group.picture || '',
          members: [...group.members],
          admins: [...group.admins],
          createdAt: group.createdAt,
          accepted: group.accepted ?? true,
          secret: group.secret || `secret-${group.id}`,
        })
      }
    },
    upsertGroup: async (group: {
      id: string
      name: string
      description?: string
      picture?: string
      members: string[]
      admins: string[]
      createdAt: number
      accepted?: boolean
      secret?: string
    }) => {
      runtimeGroups.set(group.id, {
        id: group.id,
        name: group.name,
        description: group.description || '',
        picture: group.picture || '',
        members: [...group.members],
        admins: [...group.admins],
        createdAt: group.createdAt,
        accepted: group.accepted ?? true,
        secret: group.secret || `secret-${group.id}`,
      })
    },
    createGroup: async (name: string, memberPubkeys: string[]) => {
      const members = Array.from(new Set([MY_PUBKEY, ...memberPubkeys]))
      const group = {
        id: `group-${Math.random().toString(36).slice(2, 10)}`,
        name,
        description: '',
        picture: '',
        members,
        admins: [MY_PUBKEY],
        createdAt: Date.now(),
        accepted: true,
        secret: 'f'.repeat(64),
      }
      runtimeGroups.set(group.id, group)
      return { group }
    },
    sendGroupEvent: async (
      groupId: string,
      event: { kind: number; content: string; tags?: string[][] },
    ) => {
      const group = runtimeGroups.get(groupId)
      if (group) {
        for (const recipient of group.members) {
          if (recipient === MY_PUBKEY) continue
          sendEventCalls.push({
            recipient,
            event: {
              content: event.content,
              kind: event.kind,
              tags: event.tags || [],
            },
          })
        }
      }
      return {
        inner: {
          id: `inner-${Math.random().toString(36).slice(2, 10)}`,
          kind: event.kind,
          content: event.content,
          tags: event.tags || [],
          created_at: Math.floor(Date.now() / 1000),
          pubkey: MY_PUBKEY,
        },
        outer: {
          id: `outer-${Math.random().toString(36).slice(2, 10)}`,
        },
      }
    },
    removeGroup: (groupId: string) => {
      runtimeGroups.delete(groupId)
    },
  }),
}))

vi.mock('nostr-double-ratchet', async () => {
  const actual = await import('nostr-double-ratchet')
  return {
    ...(actual as object),
    GroupManager: actual.GroupManager,
    isGroupAdmin: (group: { admins?: string[] }, pubkey: string) => {
      return Array.isArray(group.admins) && group.admins.includes(pubkey)
    },
    isGroupRosterFactEvent: actual.isGroupRosterFactEvent,
    parseGroupRosterFactEvent: (event: {
      id: string
      kind: number
      pubkey: string
      created_at: number
      content: string
      tags: string[][]
    }) => {
      if (!actual.isGroupRosterFactEvent(event)) {
        throw new Error('Event is not a GroupRoster fact')
      }
      const tagValues = (name: string) =>
        event.tags.filter((tag) => tag[0] === name).map((tag) => tag[1]).filter(Boolean)
      const tagValue = (name: string) => tagValues(name)[0]
      const subjects = event.tags
        .filter((tag) => tag[0] === 'i' && tag[2] === 'subject')
        .map((tag) => tag[1])
        .filter(Boolean)
      if (subjects.length !== 1) throw new Error('GroupRoster fact must have exactly one subject i tag')
      const groupId = subjects[0]
      if (tagValue('d') !== groupId) throw new Error('GroupRoster d/subject tag mismatch')
      const members = Array.from(new Set(tagValues('member'))).sort()
      const admins = Array.from(new Set(tagValues('admin'))).sort()
      return {
        eventId: event.id,
        signerPubkey: event.pubkey,
        groupId,
        revision: Number(tagValue('revision') || 0),
        createdBy: tagValue('created_by') || event.pubkey,
        updatedAt: Number(tagValue('updated_at') || event.created_at),
        eventCreatedAt: event.created_at,
        group: {
          id: groupId,
          name: tagValue('name') || '',
          members,
          admins,
          createdAt: Number(tagValue('created_at') || 0),
        },
      }
    },
    parseReaction: (content: string) => ({ emoji: content, isRemoval: content === '-' }),
  }
})

vi.mock('nostr-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nostr-tools')>()
  return {
    ...actual,
    getEventHash: actual.getEventHash,
    verifyEvent: () => true,
  }
})

vi.mock('./storage', () => ({
  saveGroup: vi.fn().mockResolvedValue(undefined),
  getAllGroups: vi.fn().mockResolvedValue([]),
  deleteGroupFromDb: vi.fn().mockResolvedValue(undefined),
  saveMessage: vi.fn().mockResolvedValue(undefined),
  getMessagesForSession: vi.fn().mockResolvedValue([]),
  deleteMessage: vi.fn().mockResolvedValue(undefined),
  deleteMessagesForSession: vi.fn().mockResolvedValue(undefined),
  updateMessageStatus: vi.fn().mockResolvedValue(undefined),
  updateMessageSentToRelays: vi.fn().mockResolvedValue(undefined),
  updateMessageRecipientStatuses: vi.fn().mockResolvedValue(undefined),
  updateMessageDeliveryTrace: vi.fn().mockResolvedValue(undefined),
  getSessionManagerValue: vi.fn((key: string) => Promise.resolve(sessionManagerValues.get(key))),
  putSessionManagerValue: vi.fn((key: string, value: unknown) => {
    sessionManagerValues.set(key, value)
    return Promise.resolve(undefined)
  }),
  deleteSessionManagerValue: vi.fn((key: string) => {
    sessionManagerValues.delete(key)
    return Promise.resolve(undefined)
  }),
  listSessionManagerKeys: vi.fn((prefix = '') =>
    Promise.resolve([...sessionManagerValues.keys()].filter((key) => key.startsWith(prefix)))
  ),
}))

vi.mock('./typingState', () => ({
  setRemoteTyping: vi.fn(),
  clearRemoteTyping: vi.fn(),
  TYPING_EXPIRY_MS: 10000,
}))

// --- Tests ---

describe('groups', () => {
  beforeEach(async () => {
    sendEventCalls.length = 0
    publishedGroupRosterFacts.length = 0
    sessionManagerValues.clear()
    runtimeGroups.clear()
    // Reset group stores between tests
    const { groups, groupMessages, currentGroupId } = await import('./groups')
    groups.set(new Map())
    groupMessages.set(new Map())
    currentGroupId.set(null)
    const typingState = await import('./typingState')
    vi.mocked(typingState.setRemoteTyping).mockClear()
    vi.mocked(typingState.clearRemoteTyping).mockClear()
  })

  describe('createGroup', () => {
    it('creates a group with the creator as admin', async () => {
      const { createGroup, groups } = await import('./groups')
      const group = await createGroup('Test Group', [MEMBER_B, MEMBER_C])

      expect(group.name).toBe('Test Group')
      expect(group.members).toContain(MY_PUBKEY)
      expect(group.members).toContain(MEMBER_B)
      expect(group.members).toContain(MEMBER_C)
      expect(group.admins).toEqual([MY_PUBKEY])

      const stored = get(groups).get(group.id)
      expect(stored).toBeDefined()
      expect(stored!.admins).toEqual([MY_PUBKEY])
    })

    it('deduplicates creator from member list', async () => {
      const { createGroup } = await import('./groups')
      const group = await createGroup('Dedup Test', [MY_PUBKEY, MEMBER_B])

      const myCount = group.members.filter(m => m === MY_PUBKEY).length
      expect(myCount).toBe(1)
    })

    it('publishes a group_roster fact snapshot without the group secret', async () => {
      const { createGroup, GROUP_ROSTER_FACT_KIND, GROUP_ROSTER_FACT_TYPE } = await import('./groups')
      const group = await createGroup('Roster Fact Test', [MEMBER_B])

      await vi.waitFor(() => {
        expect(publishedGroupRosterFacts.length).toBeGreaterThan(0)
      })
      const fact = publishedGroupRosterFacts.at(-1)!
      expect(fact.kind).toBe(GROUP_ROSTER_FACT_KIND)
      expect(fact.content).toBe('')
      expect(fact.tags).toContainEqual(['type', GROUP_ROSTER_FACT_TYPE])
      expect(fact.tags).toContainEqual(['d', group.id])
      expect(fact.tags).toContainEqual(['i', group.id, 'subject'])
      expect(fact.tags).toContainEqual(['name', 'Roster Fact Test'])
      expect(fact.tags).toContainEqual(['member', MY_PUBKEY])
      expect(fact.tags).toContainEqual(['member', MEMBER_B])
      expect(fact.tags).toContainEqual(['admin', MY_PUBKEY])
      expect(fact.tags.some((tag) => tag[0] === 'secret')).toBe(false)
    })
  })

  describe('admin enforcement', () => {
    it('allows admin to update group name', async () => {
      const { createGroup, updateGroupInfo, groups } = await import('./groups')
      const group = await createGroup('Original', [MEMBER_B])

      updateGroupInfo(group.id, { name: 'Updated' })

      const updated = get(groups).get(group.id)
      expect(updated!.name).toBe('Updated')
    })

    it('allows admin to update group description', async () => {
      const { createGroup, updateGroupInfo, groups } = await import('./groups')
      const group = await createGroup('Desc Test', [MEMBER_B])

      updateGroupInfo(group.id, { description: 'A test group' })

      const updated = get(groups).get(group.id)
      expect(updated!.description).toBe('A test group')
    })

    it('allows admin to update group picture', async () => {
      const { createGroup, updateGroupInfo, groups } = await import('./groups')
      const group = await createGroup('Pic Test', [MEMBER_B])

      updateGroupInfo(group.id, { picture: 'nhash://nhash1abc/pic.jpg' })

      const updated = get(groups).get(group.id)
      expect(updated!.picture).toBe('nhash://nhash1abc/pic.jpg')
    })
  })

  describe('addGroupMember', () => {
    it('admin can add a new member', async () => {
      const { createGroup, addGroupMember, groups } = await import('./groups')
      const group = await createGroup('Add Test', [MEMBER_B])

      addGroupMember(group.id, MEMBER_C)

      const updated = get(groups).get(group.id)
      expect(updated!.members).toContain(MEMBER_C)
    })

    it('does not add a member who is already in the group', async () => {
      const { createGroup, addGroupMember, groups } = await import('./groups')
      const group = await createGroup('Dup Add Test', [MEMBER_B])

      addGroupMember(group.id, MEMBER_B)

      const updated = get(groups).get(group.id)
      const count = updated!.members.filter(m => m === MEMBER_B).length
      expect(count).toBe(1)
    })

    it('does not add a member without a chat session', async () => {
      const { createGroup, addGroupMember, groups } = await import('./groups')
      const NO_SESSION = 'eeee'.repeat(16)
      const group = await createGroup('No Session Test', [MEMBER_B])

      addGroupMember(group.id, NO_SESSION)

      const updated = get(groups).get(group.id)
      expect(updated!.members).not.toContain(NO_SESSION)
    })

    it('publishes an updated group_roster fact when membership changes', async () => {
      const { createGroup, addGroupMember } = await import('./groups')
      const group = await createGroup('Roster Member Test', [MEMBER_B])
      await vi.waitFor(() => {
        expect(publishedGroupRosterFacts.length).toBeGreaterThan(0)
      })
      publishedGroupRosterFacts.length = 0

      addGroupMember(group.id, MEMBER_C)

      await vi.waitFor(() => {
        expect(publishedGroupRosterFacts.length).toBeGreaterThan(0)
      })
      const fact = publishedGroupRosterFacts.at(-1)!
      expect(fact.tags).toContainEqual(['d', group.id])
      expect(fact.tags).toContainEqual(['i', group.id, 'subject'])
      expect(fact.tags).toContainEqual(['member', MEMBER_B])
      expect(fact.tags).toContainEqual(['member', MEMBER_C])
      expect(fact.tags).toContainEqual(['admin', MY_PUBKEY])
    })
  })

  describe('removeGroupMember', () => {
    it('admin can remove a member', async () => {
      const { createGroup, removeGroupMember, groups } = await import('./groups')
      const group = await createGroup('Remove Test', [MEMBER_B, MEMBER_C])

      removeGroupMember(group.id, MEMBER_C)

      const updated = get(groups).get(group.id)
      expect(updated!.members).not.toContain(MEMBER_C)
    })

    it('removing a member also removes their admin status', async () => {
      const { createGroup, addGroupAdmin, removeGroupMember, groups } = await import('./groups')
      const group = await createGroup('Remove Admin Test', [MEMBER_B, MEMBER_C])

      addGroupAdmin(group.id, MEMBER_B)
      let updated = get(groups).get(group.id)
      expect(updated!.admins).toContain(MEMBER_B)

      removeGroupMember(group.id, MEMBER_B)
      updated = get(groups).get(group.id)
      expect(updated!.members).not.toContain(MEMBER_B)
      expect(updated!.admins).not.toContain(MEMBER_B)
    })

    it('admin cannot remove themselves', async () => {
      const { createGroup, removeGroupMember, groups } = await import('./groups')
      const group = await createGroup('Self Remove Test', [MEMBER_B])

      removeGroupMember(group.id, MY_PUBKEY)

      const updated = get(groups).get(group.id)
      expect(updated!.members).toContain(MY_PUBKEY)
    })

  })

  describe('admin management', () => {
    it('admin can promote another member to admin', async () => {
      const { createGroup, addGroupAdmin, groups } = await import('./groups')
      const group = await createGroup('Promote Test', [MEMBER_B])

      addGroupAdmin(group.id, MEMBER_B)

      const updated = get(groups).get(group.id)
      expect(updated!.admins).toContain(MEMBER_B)
    })

    it('admin can demote another admin', async () => {
      const { createGroup, addGroupAdmin, removeGroupAdmin, groups } = await import('./groups')
      const group = await createGroup('Demote Test', [MEMBER_B])
      addGroupAdmin(group.id, MEMBER_B)

      removeGroupAdmin(group.id, MEMBER_B)

      const updated = get(groups).get(group.id)
      expect(updated!.admins).not.toContain(MEMBER_B)
    })

    it('cannot remove the last admin', async () => {
      const { createGroup, removeGroupAdmin, groups } = await import('./groups')
      const group = await createGroup('Last Admin Test', [MEMBER_B])

      removeGroupAdmin(group.id, MY_PUBKEY)

      const updated = get(groups).get(group.id)
      expect(updated!.admins).toContain(MY_PUBKEY)
    })

    it('cannot promote a non-member to admin', async () => {
      const { createGroup, addGroupAdmin, groups } = await import('./groups')
      const group = await createGroup('Non-member Admin Test', [MEMBER_B])
      const stranger = 'ffff'.repeat(16)

      addGroupAdmin(group.id, stranger)

      const updated = get(groups).get(group.id)
      expect(updated!.admins).not.toContain(stranger)
    })
  })

  describe('group_roster fact ingest', () => {
    it('creates a pending local group from a valid roster fact', async () => {
      const { handleGroupRosterFactEvent, groups } = await import('./groups')
      const groupId = 'fact-created-group'

      const handled = handleGroupRosterFactEvent(makeRosterFactEvent({
        groupId,
        name: 'Fact Created',
        members: [ROSTER_ADMIN, MY_PUBKEY],
        admins: [ROSTER_ADMIN],
      }))

      expect(handled).toBe(true)
      const group = get(groups).get(groupId)
      expect(group).toBeDefined()
      expect(group!.name).toBe('Fact Created')
      expect(group!.members).toEqual([MY_PUBKEY, ROSTER_ADMIN].sort())
      expect(group!.admins).toEqual([ROSTER_ADMIN])
      expect(group!.accepted).toBe(false)
      expect(group!.secret).toBeUndefined()
    })

    it('creates a local group from an authenticated pairwise roster fact rumor', async () => {
      const { handleGroupRosterFactRumor, groups } = await import('./groups')
      const groupId = 'fact-rumor-created-group'

      const handled = handleGroupRosterFactRumor(makeRosterFactEvent({
        groupId,
        name: 'Fact Rumor Created',
        members: [ROSTER_ADMIN, MY_PUBKEY],
        admins: [ROSTER_ADMIN],
      }) as unknown as Rumor)

      expect(handled).toBe(true)
      const group = get(groups).get(groupId)
      expect(group).toBeDefined()
      expect(group!.name).toBe('Fact Rumor Created')
      expect(group!.secret).toBeUndefined()
    })

    it('updates an existing group snapshot from an admin roster fact', async () => {
      const { handleGroupRosterFactEvent, groups } = await import('./groups')
      const groupId = 'fact-updated-group'
      handleGroupRosterFactEvent(makeRosterFactEvent({
        groupId,
        name: 'Before',
        members: [ROSTER_ADMIN, MY_PUBKEY],
        admins: [ROSTER_ADMIN],
        revision: 1,
      }))

      const handled = handleGroupRosterFactEvent(makeRosterFactEvent({
        groupId,
        name: 'After',
        members: [ROSTER_ADMIN, MY_PUBKEY, MEMBER_C],
        admins: [ROSTER_ADMIN],
        revision: 2,
      }))

      expect(handled).toBe(true)
      const group = get(groups).get(groupId)
      expect(group!.name).toBe('After')
      expect(group!.members).toContain(MEMBER_C)
      expect(group!.secret).toBeUndefined()
    })

    it('rejects initial roster facts not signed by an admin', async () => {
      const { handleGroupRosterFactEvent, groups } = await import('./groups')
      const groupId = 'fact-reject-initial-nonadmin'

      const handled = handleGroupRosterFactEvent(makeRosterFactEvent({
        groupId,
        name: 'Fake Group',
        members: [ROSTER_MEMBER, MY_PUBKEY],
        admins: [ROSTER_ADMIN],
        signerSecret: ROSTER_MEMBER_SECRET,
      }))

      expect(handled).toBe(false)
      expect(get(groups).has(groupId)).toBe(false)
    })

    it('rejects updates not signed by an existing admin', async () => {
      const { handleGroupRosterFactEvent, groups } = await import('./groups')
      const groupId = 'fact-reject-update-nonadmin'
      handleGroupRosterFactEvent(makeRosterFactEvent({
        groupId,
        name: 'Admin Group',
        members: [ROSTER_ADMIN, ROSTER_MEMBER, MY_PUBKEY],
        admins: [ROSTER_ADMIN],
        revision: 1,
      }))

      const handled = handleGroupRosterFactEvent(makeRosterFactEvent({
        groupId,
        name: 'Hacked Group',
        members: [ROSTER_ADMIN, ROSTER_MEMBER, MY_PUBKEY],
        admins: [ROSTER_MEMBER],
        revision: 2,
        signerSecret: ROSTER_MEMBER_SECRET,
      }))

      expect(handled).toBe(false)
      const group = get(groups).get(groupId)!
      expect(group.name).toBe('Admin Group')
      expect(group.admins).toEqual([ROSTER_ADMIN])
    })

    it('deletes the local group when an admin roster fact removes us', async () => {
      const { handleGroupRosterFactEvent, groups } = await import('./groups')
      const groupId = 'fact-removes-local-member'
      handleGroupRosterFactEvent(makeRosterFactEvent({
        groupId,
        name: 'Removal Test',
        members: [ROSTER_ADMIN, MY_PUBKEY],
        admins: [ROSTER_ADMIN],
        revision: 1,
      }))
      expect(get(groups).has(groupId)).toBe(true)

      const handled = handleGroupRosterFactEvent(makeRosterFactEvent({
        groupId,
        name: 'Removal Test',
        members: [ROSTER_ADMIN],
        admins: [ROSTER_ADMIN],
        revision: 2,
      }))

      expect(handled).toBe(true)
      expect(get(groups).has(groupId)).toBe(false)
    })

    it('accepts admin roster facts that add a new member', async () => {
      const { handleGroupRosterFactEvent, groups } = await import('./groups')
      const groupId = 'fact-adds-member'
      handleGroupRosterFactEvent(makeRosterFactEvent({
        groupId,
        name: 'Expandable',
        members: [ROSTER_ADMIN, MY_PUBKEY],
        admins: [ROSTER_ADMIN],
        revision: 1,
      }))

      const handled = handleGroupRosterFactEvent(makeRosterFactEvent({
        groupId,
        name: 'Expandable',
        members: [ROSTER_ADMIN, ROSTER_MEMBER, MY_PUBKEY],
        admins: [ROSTER_ADMIN],
        revision: 2,
      }))

      expect(handled).toBe(true)
      expect(get(groups).get(groupId)!.members).toContain(ROSTER_MEMBER)
    })
  })

  describe('sendGroupMessage', () => {
    it('adds message to group messages store', async () => {
      const { createGroup, sendGroupMessage, groupMessages } = await import('./groups')
      const group = await createGroup('Msg Test', [MEMBER_B])

      sendGroupMessage(group.id, 'Hello group!')

      const msgs = get(groupMessages).get(group.id)!
      expect(msgs.length).toBe(1)
      expect(msgs[0].content).toBe('Hello group!')
      expect(msgs[0].isMine).toBe(true)
      expect(msgs[0].senderPubkey).toBe(MY_PUBKEY)
    })

    it('fans out message to all members', async () => {
      const { createGroup, sendGroupMessage } = await import('./groups')
      const group = await createGroup('Fan Msg Test', [MEMBER_B, MEMBER_C])
      sendEventCalls.length = 0

      sendGroupMessage(group.id, 'Hello all!')

      await waitForRecipients(MY_PUBKEY, MEMBER_B, MEMBER_C)
    })

    it('reconciles the local message id to the serialized runtime rumor id', async () => {
      const { createGroup, sendGroupMessage, groupMessages } = await import('./groups')
      const group = await createGroup('Runtime ID Test', [MEMBER_B])

      sendGroupMessage(group.id, 'Runtime id hello')
      const initialMessage = get(groupMessages).get(group.id)![0]
      expect(initialMessage.id).not.toMatch(/^[0-9a-f]{64}$/)

      await vi.waitFor(() => {
        expect(get(groupMessages).get(group.id)![0].id).toMatch(/^[0-9a-f]{64}$/)
      })
    })

    it('marks group messages sent when their inner id is accepted by relays', async () => {
      const { createGroup, sendGroupMessage, groupMessages } = await import('./groups')
      const { notifyMessageRelayPublish } = await import('./messageRelayStatus')
      const group = await createGroup('Relay Ack Test', [MEMBER_B])

      sendGroupMessage(group.id, 'Relay ack hello')
      await vi.waitFor(() => {
        expect(get(groupMessages).get(group.id)![0].id).toMatch(/^[0-9a-f]{64}$/)
      })
      const messageId = get(groupMessages).get(group.id)![0].id

      notifyMessageRelayPublish(messageId, ['wss://relay.two', 'wss://relay.one'])

      await vi.waitFor(() => {
        expect(get(groupMessages).get(group.id)![0].sentToRelays).toEqual([
          'wss://relay.one',
          'wss://relay.two',
        ])
      })
    })

    it('applies group disappearing TTL to outgoing messages', async () => {
      const { createGroup, sendGroupMessage, groupMessages } = await import('./groups')
      const { expirationStore } = await import('./expirationStore')
      const group = await createGroup('TTL Msg Test', [MEMBER_B, MEMBER_C])
      expirationStore.setExpiration(group.id, 60)
      sendEventCalls.length = 0

      const before = Math.floor(Date.now() / 1000)
      sendGroupMessage(group.id, 'TTL hello')
      const after = Math.floor(Date.now() / 1000)

      const msgs = get(groupMessages).get(group.id)!
      expect(msgs).toHaveLength(1)
      expect(msgs[0].expiresAt).toBeDefined()
      expect(msgs[0].expiresAt).toBeGreaterThanOrEqual(before + 60)
      expect(msgs[0].expiresAt).toBeLessThanOrEqual(after + 60)

      await vi.waitFor(() => {
        expect(sendEventCalls.length).toBeGreaterThan(0)
      })
      const sentMessages = sendEventCalls
        .map((call) => call.event as { content?: string; tags?: string[][] })
        .map(parseSentRuntimeRumor)
        .filter((event): event is { content: string; tags: string[][] } => event?.content === 'TTL hello')

      expect(sentMessages.length).toBeGreaterThan(0)
      for (const event of sentMessages) {
        const expirationTag = event.tags?.find((t) => t[0] === 'expiration')
        expect(expirationTag).toBeDefined()
        expect(expirationTag?.[1]).toMatch(/^\d+$/)
        const expiresAt = Number(expirationTag?.[1])
        expect(expiresAt).toBeGreaterThanOrEqual(before + 60)
        expect(expiresAt).toBeLessThanOrEqual(after + 60)
      }
    })
  })

  describe('handleGroupEvent - messages', () => {
    it('adds incoming message from group member', async () => {
      const { createGroup, handleGroupEvent, groupMessages } = await import('./groups')
      const group = await createGroup('Recv Test', [MEMBER_B])

      const rumor = makeMessageRumor(group.id, 'Hi from B!', MEMBER_B)
      handleGroupEvent(rumor, MEMBER_B, { id: 'outer-b' })

      const msgs = get(groupMessages).get(group.id)!
      const incoming = msgs.find(m => m.content === 'Hi from B!')
      expect(incoming).toBeDefined()
      expect(incoming!.isMine).toBe(false)
      expect(incoming!.senderPubkey).toBe(MEMBER_B)
      expect(incoming!.deliveryChannels).toEqual(['message servers'])
      expect(incoming!.outerEventIds).toEqual(['outer-b'])
    })

    it('unwraps serialized runtime rumors from native group payloads', async () => {
      const { createGroup, handleGroupEvent, groupMessages } = await import('./groups')
      const group = await createGroup('Native Payload Test', [MEMBER_B])
      const inner = { ...makeMessageRumor(group.id, 'Native runtime payload', MEMBER_B), id: '' }
      const outer = makeMessageRumor(group.id, JSON.stringify(inner), MEMBER_B)

      handleGroupEvent(outer, MEMBER_B, { id: 'outer-native' }, MEMBER_B)

      const msgs = get(groupMessages).get(group.id)!
      const incoming = msgs.find(m => m.content === 'Native runtime payload')
      expect(incoming).toBeDefined()
      expect(incoming!.id).toMatch(/^[0-9a-f]{64}$/)
      expect(incoming!.outerEventIds).toEqual(['outer-native'])
    })

    it('deduplicates messages by id', async () => {
      const { createGroup, handleGroupEvent, groupMessages } = await import('./groups')
      const group = await createGroup('Dedup Msg Test', [MEMBER_B])

      const rumor = makeMessageRumor(group.id, 'Duplicate!', MEMBER_B)
      handleGroupEvent(rumor, MEMBER_B)
      handleGroupEvent(rumor, MEMBER_B)

      const msgs = get(groupMessages).get(group.id)!
      const dupes = msgs.filter(m => m.content === 'Duplicate!')
      expect(dupes.length).toBe(1)
    })

    it('ignores own messages coming back from the same device', async () => {
      const { createGroup, handleGroupEvent, groupMessages } = await import('./groups')
      const group = await createGroup('Echo Test', [MEMBER_B])

      const rumor = makeMessageRumor(group.id, 'My own echo', MY_PUBKEY)
      handleGroupEvent(rumor, MY_PUBKEY, undefined, MY_PUBKEY)

      const msgs = get(groupMessages).get(group.id)!
      const echo = msgs.find(m => m.content === 'My own echo' && !m.isMine)
      expect(echo).toBeUndefined()
    })

    it('accepts own messages coming from another device', async () => {
      const { createGroup, handleGroupEvent, groupMessages } = await import('./groups')
      const group = await createGroup('Cross Device Echo Test', [MEMBER_B])

      const rumor = makeMessageRumor(group.id, 'My other device echo', MY_PUBKEY)
      handleGroupEvent(rumor, MY_PUBKEY, undefined, OTHER_DEVICE)

      const msgs = get(groupMessages).get(group.id)!
      const echo = msgs.find(m => m.content === 'My other device echo')
      expect(echo).toBeDefined()
      expect(echo!.isMine).toBe(true)
      expect(echo!.senderPubkey).toBe(MY_PUBKEY)
    })

    it('tracks group receipts per recipient', async () => {
      const { createGroup, sendGroupMessage, handleGroupEvent, groupMessages } = await import('./groups')
      const group = await createGroup('Receipt Test', [MEMBER_B, MEMBER_C])

      sendGroupMessage(group.id, 'Needs receipt')
      await vi.waitFor(() => {
        expect(get(groupMessages).get(group.id)![0].id).toMatch(/^[0-9a-f]{64}$/)
      })
      const messageId = get(groupMessages).get(group.id)![0].id

      handleGroupEvent(makeReceiptRumor(group.id, 'seen', [messageId], MEMBER_B), MEMBER_B)

      expect(get(groupMessages).get(group.id)![0].recipientStatuses).toEqual({
        [MEMBER_B]: 'seen',
      })
    })

    it('sets typing indicator for group typing rumor', async () => {
      const { createGroup, handleGroupEvent } = await import('./groups')
      const typingState = await import('./typingState')
      const group = await createGroup('Typing Test', [MEMBER_B])

      const rumor = makeTypingRumor(group.id, MEMBER_B)
      handleGroupEvent(rumor, MEMBER_B)

      expect(typingState.setRemoteTyping).toHaveBeenCalledWith(
        `group:${group.id}`,
        rumor.created_at
      )
      expect(typingState.clearRemoteTyping).not.toHaveBeenCalled()
    })

    it('clears typing indicator for group typing turn-off rumor', async () => {
      const { createGroup, handleGroupEvent } = await import('./groups')
      const typingState = await import('./typingState')
      const group = await createGroup('Typing Off Test', [MEMBER_B])

      const rumor = makeTypingRumor(group.id, MEMBER_B, [['expiration', '1']])
      handleGroupEvent(rumor, MEMBER_B)

      expect(typingState.setRemoteTyping).not.toHaveBeenCalled()
      expect(typingState.clearRemoteTyping).toHaveBeenCalledWith(`group:${group.id}`)
    })
  })

  describe('deleteGroup', () => {
    it('removes group from store', async () => {
      const { createGroup, deleteGroup, groups, groupMessages } = await import('./groups')
      const group = await createGroup('Delete Test', [MEMBER_B])

      await deleteGroup(group.id)

      expect(get(groups).has(group.id)).toBe(false)
      expect(get(groupMessages).has(group.id)).toBe(false)
    })
  })

  describe('clearGroupData', () => {
    it('clears all group state for logout', async () => {
      const { createGroup, clearGroupData, groups, groupMessages, currentGroupId } = await import('./groups')
      const group = await createGroup('Logout Test', [MEMBER_B])

      currentGroupId.set(group.id)
      groupMessages.update(gm => {
        gm.set(group.id, [{
          id: 'msg-1',
          content: 'hello',
          timestamp: Date.now(),
          isMine: true,
        }])
        return gm
      })

      clearGroupData()

      expect(get(groups).size).toBe(0)
      expect(get(groupMessages).size).toBe(0)
      expect(get(currentGroupId)).toBe(null)
    })
  })

  describe('isAdmin', () => {
    it('returns true for admin', async () => {
      const { createGroup, isAdmin } = await import('./groups')
      const group = await createGroup('Admin Check', [MEMBER_B])

      expect(isAdmin(group, MY_PUBKEY)).toBe(true)
    })

    it('returns false for non-admin member', async () => {
      const { createGroup, isAdmin } = await import('./groups')
      const group = await createGroup('Non-admin Check', [MEMBER_B])

      expect(isAdmin(group, MEMBER_B)).toBe(false)
    })
  })

  describe('group secret', () => {
    it('createGroup includes a secret', async () => {
      const { createGroup } = await import('./groups')
      const group = await createGroup('Secret Test', [MEMBER_B])

      expect(group.secret).toBeDefined()
      expect(group.secret!.length).toBe(64) // 32 bytes in hex
    })

    it('createGroup sets accepted to true', async () => {
      const { createGroup } = await import('./groups')
      const group = await createGroup('Accepted Test', [MEMBER_B])

      expect(group.accepted).toBe(true)
    })

    it('secret rotates on addGroupMember', async () => {
      const { createGroup, addGroupMember, groups } = await import('./groups')
      const group = await createGroup('Rotate Add', [MEMBER_B])
      const originalSecret = group.secret

      addGroupMember(group.id, MEMBER_C)

      const updated = get(groups).get(group.id)
      expect(updated!.secret).toBeDefined()
      expect(updated!.secret).not.toBe(originalSecret)
    })

    it('secret rotates on removeGroupMember', async () => {
      const { createGroup, removeGroupMember, groups } = await import('./groups')
      const group = await createGroup('Rotate Remove', [MEMBER_B, MEMBER_C])
      const originalSecret = group.secret

      removeGroupMember(group.id, MEMBER_C)

      const updated = get(groups).get(group.id)
      expect(updated!.secret).toBeDefined()
      expect(updated!.secret).not.toBe(originalSecret)
    })

  })

  describe('group acceptance', () => {
    it('roster facts from another admin create pending groups without secrets', async () => {
      const { handleGroupRosterFactEvent, groups } = await import('./groups')
      const groupId = 'test-group-pending'

      handleGroupRosterFactEvent(makeRosterFactEvent({
        groupId,
        name: 'Pending Group',
        members: [ROSTER_ADMIN, MY_PUBKEY],
        admins: [ROSTER_ADMIN],
      }))

      const group = get(groups).get(groupId)
      expect(group).toBeDefined()
      expect(group!.accepted).toBe(false)
      expect(group!.secret).toBeUndefined()
    })

    it('acceptGroupInvitation sets accepted to true', async () => {
      const { handleGroupRosterFactEvent, acceptGroupInvitation, groups } = await import('./groups')

      const groupId = 'test-group-accept'
      handleGroupRosterFactEvent(makeRosterFactEvent({
        groupId,
        name: 'Accept Test',
        members: [ROSTER_ADMIN, MY_PUBKEY],
        admins: [ROSTER_ADMIN],
      }))

      expect(get(groups).get(groupId)!.accepted).toBe(false)

      acceptGroupInvitation(groupId)
      expect(get(groups).get(groupId)!.accepted).toBe(true)
    })

    it('roster fact updates preserve accepted status', async () => {
      const { handleGroupRosterFactEvent, acceptGroupInvitation, groups } = await import('./groups')

      const groupId = 'test-group-preserve-accepted'
      handleGroupRosterFactEvent(makeRosterFactEvent({
        groupId,
        name: 'Preserve Test',
        members: [ROSTER_ADMIN, MY_PUBKEY],
        admins: [ROSTER_ADMIN],
        revision: 1,
      }))
      acceptGroupInvitation(groupId)

      handleGroupRosterFactEvent(makeRosterFactEvent({
        groupId,
        name: 'Updated Name',
        members: [ROSTER_ADMIN, MY_PUBKEY],
        admins: [ROSTER_ADMIN],
        revision: 2,
      }))

      const group = get(groups).get(groupId)
      expect(group!.name).toBe('Updated Name')
      expect(group!.accepted).toBe(true) // should stay accepted
    })
  })
})

// --- Helpers ---

function makeRosterFactEvent({
  groupId,
  name,
  members,
  admins,
  revision = 1,
  signerSecret = ROSTER_ADMIN_SECRET,
}: {
  groupId: string
  name: string
  members: string[]
  admins: string[]
  revision?: number
  signerSecret?: Uint8Array
}): VerifiedEvent {
  const createdAt = 1700000000
  const updatedAt = 1700000000 + revision
  const signerPubkey = getPublicKey(signerSecret)
  return finalizeEvent({
    kind: 37368,
    content: '',
    created_at: updatedAt,
    tags: [
      ['type', 'group_roster'],
      ['schema', '1'],
      ['d', groupId],
      ['i', groupId, 'subject'],
      ['group_id', groupId],
      ['revision', String(revision)],
      ['name', name],
      ['created_at', String(createdAt)],
      ['updated_at', String(updatedAt)],
      ['created_by', admins[0] || signerPubkey],
      ...members.map((member) => ['member', member]),
      ...admins.map((admin) => ['admin', admin]),
    ],
  }, signerSecret)
}

function makeMessageRumor(groupId: string, content: string, pubkey: string): Rumor {
  return {
    id: Math.random().toString(36).slice(2),
    kind: 14,
    content,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['l', groupId]],
  } as Rumor
}

function parseSentRuntimeRumor(event: { content?: string; tags?: string[][] }): { content: string; tags: string[][] } | null {
  if (!event.content) return null
  try {
    const parsed = JSON.parse(event.content) as { content?: unknown; tags?: unknown }
    if (typeof parsed.content !== 'string' || !Array.isArray(parsed.tags)) return null
    const tags = parsed.tags.filter((tag): tag is string[] =>
      Array.isArray(tag) && tag.every((part) => typeof part === 'string')
    )
    return { content: parsed.content, tags }
  } catch {
    return null
  }
}

function makeReceiptRumor(
  groupId: string,
  content: 'delivered' | 'seen',
  messageIds: string[],
  pubkey: string,
): Rumor {
  return {
    id: Math.random().toString(36).slice(2),
    kind: 15,
    content,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['l', groupId], ...messageIds.map((messageId) => ['e', messageId])],
  } as Rumor
}

function makeTypingRumor(groupId: string, pubkey: string, extraTags: string[][] = []): Rumor {
  return {
    id: Math.random().toString(36).slice(2),
    kind: 25,
    content: 'typing',
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['l', groupId], ...extraTags],
  } as Rumor
}

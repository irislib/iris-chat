import { describe, it, expect, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'
import type { Rumor } from 'nostr-double-ratchet'

// --- Mocks ---

const MY_PUBKEY = 'aaaa'.repeat(16)
const MEMBER_B = 'bbbb'.repeat(16)
const MEMBER_C = 'cccc'.repeat(16)
const NON_MEMBER = 'dddd'.repeat(16)
const OTHER_DEVICE = 'eeee'.repeat(16)

vi.mock('./identity', () => {
  const { writable } = require('svelte/store')
  return {
    getPubkey: () => MY_PUBKEY,
    ndk: writable({}),
    bytesToHex: (bytes: Uint8Array) => Array.from(bytes).map((b: number) => b.toString(16).padStart(2, '0')).join(''),
  }
})

// Track sendEvent calls per recipient
const sendEventCalls: Array<{ recipient: string, event: unknown }> = []

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
  getSessionManager: () => ({
    sendEvent: (recipient: string, event: unknown) => {
      sendEventCalls.push({ recipient, event })
      return Promise.resolve(undefined)
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
    parseReaction: (content: string) => ({ emoji: content, isRemoval: content === '-' }),
  }
})

vi.mock('nostr-tools', () => ({
  getEventHash: () => Math.random().toString(36).slice(2),
}))

vi.mock('./storage', () => ({
  saveGroup: vi.fn().mockResolvedValue(undefined),
  getAllGroups: vi.fn().mockResolvedValue([]),
  deleteGroupFromDb: vi.fn().mockResolvedValue(undefined),
  saveMessage: vi.fn().mockResolvedValue(undefined),
  getMessagesForSession: vi.fn().mockResolvedValue([]),
  deleteMessagesForSession: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./typingState', () => ({
  setRemoteTyping: vi.fn(),
  clearRemoteTyping: vi.fn(),
  TYPING_EXPIRY_MS: 10000,
}))

vi.mock('./groupChannels', () => ({
  setupGroupChannel: vi.fn(),
  teardownGroupChannel: vi.fn(),
}))

// --- Tests ---

describe('groups', () => {
  beforeEach(async () => {
    sendEventCalls.length = 0
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

    it('fans out metadata to members and sender-copies it to self', async () => {
      const { createGroup } = await import('./groups')
      await createGroup('Fan Out Test', [MEMBER_B])

      // Should have sent to MEMBER_B and also sender-copied to self so
      // linked clients can materialize the group.
      expect(sendEventCalls.length).toBeGreaterThanOrEqual(1)
      const sentToB = sendEventCalls.some(c => c.recipient === MEMBER_B)
      expect(sentToB).toBe(true)
      const sentToSelf = sendEventCalls.some(c => c.recipient === MY_PUBKEY)
      expect(sentToSelf).toBe(true)
    })

    it('deduplicates creator from member list', async () => {
      const { createGroup } = await import('./groups')
      const group = await createGroup('Dedup Test', [MY_PUBKEY, MEMBER_B])

      const myCount = group.members.filter(m => m === MY_PUBKEY).length
      expect(myCount).toBe(1)
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

    it('fans out metadata update to all members including new one', async () => {
      const { createGroup, addGroupMember } = await import('./groups')
      const group = await createGroup('Fan Add Test', [MEMBER_B])
      sendEventCalls.length = 0

      addGroupMember(group.id, MEMBER_C)

      // Should send to both MEMBER_B and MEMBER_C
      const sentToB = sendEventCalls.some(c => c.recipient === MEMBER_B)
      const sentToC = sendEventCalls.some(c => c.recipient === MEMBER_C)
      expect(sentToB).toBe(true)
      expect(sentToC).toBe(true)
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

    it('fans out to removed member so they learn of removal', async () => {
      const { createGroup, removeGroupMember } = await import('./groups')
      const group = await createGroup('Fan Remove Test', [MEMBER_B, MEMBER_C])
      sendEventCalls.length = 0

      removeGroupMember(group.id, MEMBER_C)

      // Removed member should still receive the update
      const sentToC = sendEventCalls.some(c => c.recipient === MEMBER_C)
      expect(sentToC).toBe(true)
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

  describe('handleGroupEvent - metadata from admin vs non-admin', () => {
    it('accepts initial group creation from sender in admins list', async () => {
      const { handleGroupEvent, groups } = await import('./groups')

      const groupId = 'test-group-1'
      const rumor = makeMetadataRumor(groupId, {
        id: groupId,
        name: 'Admin Created',
        members: [MEMBER_B, MY_PUBKEY],
        admins: [MEMBER_B],
      })

      handleGroupEvent(rumor, MEMBER_B)

      const group = get(groups).get(groupId)
      expect(group).toBeDefined()
      expect(group!.name).toBe('Admin Created')
      expect(group!.admins).toEqual([MEMBER_B])
    })

    it('rejects initial group creation from sender NOT in admins list', async () => {
      const { handleGroupEvent, groups } = await import('./groups')

      const groupId = 'test-group-reject'
      const rumor = makeMetadataRumor(groupId, {
        id: groupId,
        name: 'Fake Group',
        members: [MEMBER_C, MY_PUBKEY],
        admins: [MEMBER_B], // Sender is MEMBER_C, not in admins
      })

      handleGroupEvent(rumor, MEMBER_C)

      expect(get(groups).has(groupId)).toBe(false)
    })

    it('accepts metadata update from existing admin', async () => {
      const { handleGroupEvent, groups } = await import('./groups')

      // First, create the group
      const groupId = 'test-group-update'
      const createRumor = makeMetadataRumor(groupId, {
        id: groupId,
        name: 'Original Name',
        members: [MEMBER_B, MY_PUBKEY],
        admins: [MEMBER_B],
      })
      handleGroupEvent(createRumor, MEMBER_B)
      expect(get(groups).get(groupId)!.name).toBe('Original Name')

      // Update from admin
      const updateRumor = makeMetadataRumor(groupId, {
        id: groupId,
        name: 'Updated Name',
        members: [MEMBER_B, MY_PUBKEY],
        admins: [MEMBER_B],
      })
      handleGroupEvent(updateRumor, MEMBER_B)

      expect(get(groups).get(groupId)!.name).toBe('Updated Name')
    })

    it('rejects metadata update from non-admin member', async () => {
      const { handleGroupEvent, groups } = await import('./groups')

      // Create group with MEMBER_B as admin
      const groupId = 'test-group-nonadmin'
      const createRumor = makeMetadataRumor(groupId, {
        id: groupId,
        name: 'Admin Group',
        members: [MEMBER_B, MEMBER_C, MY_PUBKEY],
        admins: [MEMBER_B],
      })
      handleGroupEvent(createRumor, MEMBER_B)

      // MEMBER_C (not admin) tries to update
      const updateRumor = makeMetadataRumor(groupId, {
        id: groupId,
        name: 'Hacked Name',
        members: [MEMBER_B, MEMBER_C, MY_PUBKEY],
        admins: [MEMBER_C], // Trying to make themselves admin
      })
      handleGroupEvent(updateRumor, MEMBER_C)

      // Name should not have changed
      expect(get(groups).get(groupId)!.name).toBe('Admin Group')
      // MEMBER_C should not be admin
      expect(get(groups).get(groupId)!.admins).toEqual([MEMBER_B])
    })

    it('handles member removal via metadata update', async () => {
      const { handleGroupEvent, groups } = await import('./groups')

      // Create group where we're a member
      const groupId = 'test-group-removal'
      const createRumor = makeMetadataRumor(groupId, {
        id: groupId,
        name: 'Removal Test',
        members: [MEMBER_B, MY_PUBKEY],
        admins: [MEMBER_B],
      })
      handleGroupEvent(createRumor, MEMBER_B)
      expect(get(groups).has(groupId)).toBe(true)

      // Admin removes us from the group
      const removeRumor = makeMetadataRumor(groupId, {
        id: groupId,
        name: 'Removal Test',
        members: [MEMBER_B], // We're not in members anymore
        admins: [MEMBER_B],
      })
      handleGroupEvent(removeRumor, MEMBER_B)

      // Group should be deleted locally
      expect(get(groups).has(groupId)).toBe(false)
    })

    it('rejects metadata with empty admins list', async () => {
      const { handleGroupEvent, groups } = await import('./groups')

      const groupId = 'test-group-no-admins'
      const rumor = makeMetadataRumor(groupId, {
        id: groupId,
        name: 'No Admins',
        members: [MEMBER_B, MY_PUBKEY],
        admins: [],
      })

      handleGroupEvent(rumor, MEMBER_B)

      expect(get(groups).has(groupId)).toBe(false)
    })

    it('accepts admin adding a new member via metadata', async () => {
      const { handleGroupEvent, groups } = await import('./groups')

      const groupId = 'test-group-add-via-meta'
      const createRumor = makeMetadataRumor(groupId, {
        id: groupId,
        name: 'Expandable',
        members: [MEMBER_B, MY_PUBKEY],
        admins: [MEMBER_B],
      })
      handleGroupEvent(createRumor, MEMBER_B)

      // Admin adds MEMBER_C
      const addRumor = makeMetadataRumor(groupId, {
        id: groupId,
        name: 'Expandable',
        members: [MEMBER_B, MY_PUBKEY, MEMBER_C],
        admins: [MEMBER_B],
      })
      handleGroupEvent(addRumor, MEMBER_B)

      expect(get(groups).get(groupId)!.members).toContain(MEMBER_C)
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

      const sentToSelf = sendEventCalls.some(c => c.recipient === MY_PUBKEY)
      const sentToB = sendEventCalls.some(c => c.recipient === MEMBER_B)
      const sentToC = sendEventCalls.some(c => c.recipient === MEMBER_C)
      expect(sentToSelf).toBe(true)
      expect(sentToB).toBe(true)
      expect(sentToC).toBe(true)
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

      expect(sendEventCalls.length).toBeGreaterThan(0)
      for (const call of sendEventCalls) {
        const event = call.event as { tags?: string[][] }
        const expirationTag = event.tags?.find((t) => t[0] === 'expiration')
        expect(expirationTag).toBeDefined()
        expect(expirationTag?.[1]).toMatch(/^\d+$/)
        const expiresAt = Number(expirationTag?.[1])
        expect(expiresAt).toBeGreaterThanOrEqual(before + 60)
        expect(expiresAt).toBeLessThanOrEqual(after + 60)
      }
    })
  })

  describe('fanOutGroupMetadata', () => {
    it('sender-copies metadata updates to self', async () => {
      const { createGroup, fanOutGroupMetadata } = await import('./groups')
      const group = await createGroup('Metadata Update Test', [MEMBER_B])
      sendEventCalls.length = 0

      fanOutGroupMetadata(
        group.id,
        JSON.stringify({
          id: group.id,
          name: 'Metadata Update Test',
          members: group.members,
          admins: group.admins,
        })
      )

      const sentToB = sendEventCalls.some(c => c.recipient === MEMBER_B)
      const sentToSelf = sendEventCalls.some(c => c.recipient === MY_PUBKEY)
      expect(sentToB).toBe(true)
      expect(sentToSelf).toBe(true)
    })
  })

  describe('handleGroupEvent - messages', () => {
    it('adds incoming message from group member', async () => {
      const { createGroup, handleGroupEvent, groupMessages } = await import('./groups')
      const group = await createGroup('Recv Test', [MEMBER_B])

      const rumor = makeMessageRumor(group.id, 'Hi from B!', MEMBER_B)
      handleGroupEvent(rumor, MEMBER_B)

      const msgs = get(groupMessages).get(group.id)!
      const incoming = msgs.find(m => m.content === 'Hi from B!')
      expect(incoming).toBeDefined()
      expect(incoming!.isMine).toBe(false)
      expect(incoming!.senderPubkey).toBe(MEMBER_B)
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

      const groupChannels = await import('./groupChannels')
      expect(groupChannels.teardownGroupChannel).toHaveBeenCalledWith(group.id)
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

    it('removed member does not receive new secret', async () => {
      const { createGroup, removeGroupMember, groups } = await import('./groups')
      const group = await createGroup('No Secret For Removed', [MEMBER_B, MEMBER_C])
      sendEventCalls.length = 0

      removeGroupMember(group.id, MEMBER_C)

      // Find what was sent to the removed member
      const sentToC = sendEventCalls.filter(c => c.recipient === MEMBER_C)
      expect(sentToC.length).toBeGreaterThan(0)

      // Parse the event sent to removed member - it should not contain the new secret
      const removedEvent = sentToC[0].event as { content: string }
      const removedMetadata = JSON.parse(removedEvent.content)
      expect(removedMetadata.secret).toBeUndefined()

      // But remaining members should get the new secret
      const sentToB = sendEventCalls.filter(c => c.recipient === MEMBER_B)
      expect(sentToB.length).toBeGreaterThan(0)
      const memberEvent = sentToB[0].event as { content: string }
      const memberMetadata = JSON.parse(memberEvent.content)
      expect(memberMetadata.secret).toBeDefined()
    })
  })

  describe('group acceptance', () => {
    it('handleGroupMetadata sets accepted to false for new groups', async () => {
      const { handleGroupEvent, groups } = await import('./groups')

      const groupId = 'test-group-pending'
      const rumor = makeMetadataRumor(groupId, {
        id: groupId,
        name: 'Pending Group',
        members: [MEMBER_B, MY_PUBKEY],
        admins: [MEMBER_B],
        secret: 'a'.repeat(64),
      })

      handleGroupEvent(rumor, MEMBER_B)

      const group = get(groups).get(groupId)
      expect(group).toBeDefined()
      expect(group!.accepted).toBe(false)
    })

    it('acceptGroupInvitation sets accepted to true', async () => {
      const { handleGroupEvent, acceptGroupInvitation, groups } = await import('./groups')

      const groupId = 'test-group-accept'
      const rumor = makeMetadataRumor(groupId, {
        id: groupId,
        name: 'Accept Test',
        members: [MEMBER_B, MY_PUBKEY],
        admins: [MEMBER_B],
        secret: 'b'.repeat(64),
      })

      handleGroupEvent(rumor, MEMBER_B)
      expect(get(groups).get(groupId)!.accepted).toBe(false)

      acceptGroupInvitation(groupId)
      expect(get(groups).get(groupId)!.accepted).toBe(true)
    })

    it('handleGroupMetadata preserves accepted status on update', async () => {
      const { handleGroupEvent, acceptGroupInvitation, groups } = await import('./groups')

      const groupId = 'test-group-preserve-accepted'
      const createRumor = makeMetadataRumor(groupId, {
        id: groupId,
        name: 'Preserve Test',
        members: [MEMBER_B, MY_PUBKEY],
        admins: [MEMBER_B],
        secret: 'c'.repeat(64),
      })
      handleGroupEvent(createRumor, MEMBER_B)
      acceptGroupInvitation(groupId)

      // Update from admin
      const updateRumor = makeMetadataRumor(groupId, {
        id: groupId,
        name: 'Updated Name',
        members: [MEMBER_B, MY_PUBKEY],
        admins: [MEMBER_B],
        secret: 'd'.repeat(64),
      })
      handleGroupEvent(updateRumor, MEMBER_B)

      const group = get(groups).get(groupId)
      expect(group!.name).toBe('Updated Name')
      expect(group!.accepted).toBe(true) // should stay accepted
    })

    it('handleGroupMetadata stores secret from metadata', async () => {
      const { handleGroupEvent, groups } = await import('./groups')

      const secret = 'e'.repeat(64)
      const groupId = 'test-group-secret-store'
      const rumor = makeMetadataRumor(groupId, {
        id: groupId,
        name: 'Secret Store',
        members: [MEMBER_B, MY_PUBKEY],
        admins: [MEMBER_B],
        secret,
      })

      handleGroupEvent(rumor, MEMBER_B)

      const group = get(groups).get(groupId)
      expect(group!.secret).toBe(secret)
    })
  })
})

// --- Helpers ---

function makeMetadataRumor(groupId: string, metadata: { id: string, name: string, members: string[], admins: string[], description?: string, picture?: string, secret?: string }): Rumor {
  return {
    id: Math.random().toString(36),
    kind: 40,
    content: JSON.stringify(metadata),
    pubkey: '',
    created_at: Math.floor(Date.now() / 1000),
    tags: [['l', groupId]],
  } as Rumor
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

import {beforeEach, describe, expect, it, vi} from 'vitest'

import {expirationStore} from './expirationStore'

const MY_PUBKEY = 'a'.repeat(64)
const OTHER_PUBKEY = 'b'.repeat(64)
const GROUP_ID = 'test-group-1'

const mocked = vi.hoisted(() => ({
  currentPubkey: 'a'.repeat(64),
  sessionManager: {
    setExpirationForPeer: vi.fn().mockResolvedValue(undefined),
    setExpirationForGroup: vi.fn().mockResolvedValue(undefined),
    setChatSettingsForPeer: vi.fn().mockResolvedValue(undefined),
  },
  fanOutGroupMetadata: vi.fn(),
}))

vi.mock('./identity', () => ({
  getPubkey: () => mocked.currentPubkey,
}))

vi.mock('./privateChats', () => ({
  getSessionManager: () => mocked.sessionManager,
}))

vi.mock('./groups', async () => {
  const {writable} = await import('svelte/store')
  return {
    groups: writable(new Map()),
    fanOutGroupMetadata: mocked.fanOutGroupMetadata,
  }
})

vi.mock('nostr-double-ratchet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nostr-double-ratchet')>()
  return {
    ...actual,
    buildGroupMetadataContent: (group: Record<string, unknown>) =>
      JSON.stringify({
        id: group.id,
        name: group.name,
        members: group.members,
        admins: group.admins,
      }),
  }
})

import {setGroupDisappearingMessages} from './disappearingMessages'
import {groups} from './groups'

describe('setGroupDisappearingMessages', () => {
  beforeEach(() => {
    mocked.currentPubkey = MY_PUBKEY
    mocked.fanOutGroupMetadata.mockClear()
    mocked.sessionManager.setExpirationForGroup.mockClear()
    expirationStore.clearExpiration(GROUP_ID)
    groups.set(
      new Map([
        [
          GROUP_ID,
          {
            id: GROUP_ID,
            name: 'Test Group',
            description: '',
            picture: '',
            members: [MY_PUBKEY, OTHER_PUBKEY],
            admins: [MY_PUBKEY],
            createdAt: Date.now(),
            accepted: true,
          },
        ],
      ])
    )
  })

  it('updates group expiration and publishes metadata for admins', async () => {
    await setGroupDisappearingMessages(GROUP_ID, 3600.9)

    expect(expirationStore.getExpiration(GROUP_ID)).toBe(3600)
    expect(mocked.sessionManager.setExpirationForGroup).toHaveBeenCalledWith(GROUP_ID, {
      ttlSeconds: 3600,
    })
    expect(mocked.fanOutGroupMetadata).toHaveBeenCalledWith(
      GROUP_ID,
      expect.stringContaining('"messageTtlSeconds":3600')
    )
  })

  it('rejects group disappearing-message changes from non-admins', async () => {
    mocked.currentPubkey = OTHER_PUBKEY
    groups.set(
      new Map([
        [
          GROUP_ID,
          {
            id: GROUP_ID,
            name: 'Test Group',
            description: '',
            picture: '',
            members: [MY_PUBKEY, OTHER_PUBKEY],
            admins: [MY_PUBKEY],
            createdAt: Date.now(),
            accepted: true,
          },
        ],
      ])
    )

    await setGroupDisappearingMessages(GROUP_ID, 7200)

    expect(expirationStore.getExpiration(GROUP_ID)).toBeUndefined()
    expect(mocked.sessionManager.setExpirationForGroup).not.toHaveBeenCalled()
    expect(mocked.fanOutGroupMetadata).not.toHaveBeenCalled()
  })
})

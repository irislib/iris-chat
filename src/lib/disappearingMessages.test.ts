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
  sendGroupSettingsEvent: vi.fn(),
}))

vi.mock('./identity', () => ({
  getPubkey: () => mocked.currentPubkey,
}))

vi.mock('./privateChats', () => ({
  getSessionManager: () => mocked.sessionManager,
  getNdrRuntime: () => ({
    setExpirationForPeer: mocked.sessionManager.setExpirationForPeer,
    setExpirationForGroup: mocked.sessionManager.setExpirationForGroup,
    setChatSettingsForPeer: mocked.sessionManager.setChatSettingsForPeer,
    onGroupEvent: () => () => {},
  }),
}))

vi.mock('./groups', async () => {
  const {writable} = await import('svelte/store')
  return {
    groups: writable(new Map()),
    sendGroupSettingsEvent: mocked.sendGroupSettingsEvent,
  }
})

import {setGroupDisappearingMessages} from './disappearingMessages'
import {groups} from './groups'

describe('setGroupDisappearingMessages', () => {
  beforeEach(() => {
    mocked.currentPubkey = MY_PUBKEY
    mocked.sendGroupSettingsEvent.mockClear()
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

  it('updates group expiration and sends group settings for admins', async () => {
    await setGroupDisappearingMessages(GROUP_ID, 3600.9)

    expect(expirationStore.getExpiration(GROUP_ID)).toBe(3600)
    expect(mocked.sessionManager.setExpirationForGroup).toHaveBeenCalledWith(GROUP_ID, {
      ttlSeconds: 3600,
    })
    expect(mocked.sendGroupSettingsEvent).toHaveBeenCalledWith(GROUP_ID, 3600)
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
    expect(mocked.sendGroupSettingsEvent).not.toHaveBeenCalled()
  })
})

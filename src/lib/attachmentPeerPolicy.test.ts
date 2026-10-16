import { expect, it } from 'vitest'
import { groupAttachmentOwner } from './attachmentPeerPolicy'
it('admits current members of accepted groups without granting strangers, blocked users, removed members or unaccepted groups access', () => {
  const group = { members: ['me', 'bob'], accepted: true }
  expect(groupAttachmentOwner('bob', 'me', [group], {})).toBe(true)
  expect(groupAttachmentOwner('cara', 'me', [group], {})).toBe(false)
  expect(groupAttachmentOwner('bob', 'me', [group], { bob: true })).toBe(false)
  expect(groupAttachmentOwner('bob', 'me', [{ ...group, accepted: false }], {})).toBe(false)
  expect(groupAttachmentOwner('bob', 'me', [{ members: ['bob', 'cara'] }], {})).toBe(false)
  expect(groupAttachmentOwner('bob', null, [group], {})).toBe(false)
})

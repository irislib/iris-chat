import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('./privateContactSync', async () => {
  const { writable } = await import('svelte/store')
  return { editPrivateContact: vi.fn(async () => {}), getPrivateContact: vi.fn(() => undefined), privateContactsVersion: writable(0) }
})
vi.mock('./storage', () => ({ putSessionManagerValue: vi.fn(async () => {}) }))
import { getPrivateContact } from './privateContactSync'
import { putSessionManagerValue } from './storage'
import { approveContactName, contactMemory, favoriteContact, observeContactProfile, rememberContact } from './contactMemory'

const account = 'a'.repeat(64), other = 'b'.repeat(64), person = 'c'.repeat(64)
beforeEach(() => {
  vi.mocked(getPrivateContact).mockReset()
  vi.mocked(putSessionManagerValue).mockClear()
  for (const owner of [account, other]) localStorage.removeItem(`iris-contact-memory:v1:${owner}:${person}`)
})

it('remembers only after interaction, keeps the first name, and refuses stale approval', () => {
  observeContactProfile(account, person, 'Alice')
  expect(contactMemory.get(account, person)).toBeNull()
  rememberContact(account, person)
  observeContactProfile(account, person, 'Alicia')
  expect(contactMemory.get(account, person)?.accepted_name).toBe('Alice')
  observeContactProfile(account, person, 'Alice Again')
  expect(approveContactName(account, person, 'Alicia')).toBe(false)
  expect(approveContactName(account, person, 'Alice Again')).toBe(true)
  expect(contactMemory.get(account, person)).toMatchObject({
    first_seen_name: 'Alice', accepted_name: 'Alice Again', favorite: false,
    name_changes: [{ previous_name: 'Alice', accepted_name: 'Alice Again' }],
  })
  expect(approveContactName(account, person, 'Alice Again')).toBe(false)
})

it('scopes private favorites and names to each account and accepts metadata arriving later', async () => {
  observeContactProfile(account, person, null)
  rememberContact(account, person)
  observeContactProfile(account, person, 'Alice')
  await favoriteContact(account, person, true)
  observeContactProfile(other, person, 'Alicia')
  rememberContact(other, person)
  expect(contactMemory.get(account, person)?.first_seen_name).toBe('Alice')
  expect(contactMemory.get(account, person)?.favorite).toBe(true)
  expect(contactMemory.get(other, person)?.accepted_name).toBe('Alicia')
  expect(contactMemory.get(other, person)?.favorite).toBe(false)
})

it('keeps a synced nickname in notifications when a public name changes', () => {
  vi.mocked(getPrivateContact).mockReturnValue({favorite: true, nickname: 'Private Alice', note: 'Private note'})
  observeContactProfile(account, person, 'Alice')
  rememberContact(account, person)
  observeContactProfile(account, person, 'Alicia')
  expect(putSessionManagerValue).toHaveBeenLastCalledWith(
    `iris-contact-memory:v1:${account}:${person}`,
    expect.objectContaining({accepted_name: 'Alice', nickname: 'Private Alice', favorite: true})
  )
})

import { beforeEach, expect, it } from 'vitest'
import { approveContactName, contactMemory, favoriteContact, observeContactProfile, rememberContact } from './contactMemory'

const account = 'a'.repeat(64), other = 'b'.repeat(64), person = 'c'.repeat(64)
beforeEach(() => {
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

it('scopes private favorites and names to each account and accepts metadata arriving later', () => {
  observeContactProfile(account, person, null)
  rememberContact(account, person)
  observeContactProfile(account, person, 'Alice')
  favoriteContact(account, person, true)
  observeContactProfile(other, person, 'Alicia')
  rememberContact(other, person)
  expect(contactMemory.get(account, person)?.first_seen_name).toBe('Alice')
  expect(contactMemory.get(account, person)?.favorite).toBe(true)
  expect(contactMemory.get(other, person)?.accepted_name).toBe('Alicia')
  expect(contactMemory.get(other, person)?.favorite).toBe(false)
})

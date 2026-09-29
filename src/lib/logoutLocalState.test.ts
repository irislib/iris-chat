import { expect, it } from 'vitest'
import { get } from 'svelte/store'
import { acceptChat, rejectChat, messageRequests, clearMessageRequestDecisions } from './messageRequests'
import { expirationStore } from './expirationStore'
import { setDraft, getDraft, clearDrafts } from './drafts'

it('logout clears private chat decisions, expiry settings and drafts from both memory and storage', () => {
  acceptChat('trusted-in-old-profile')
  rejectChat('blocked-in-old-profile')
  expirationStore.setExpiration('trusted-in-old-profile', 60)
  setDraft('trusted-in-old-profile', 'Unsent private message')
  clearMessageRequestDecisions()
  expirationStore.clear()
  clearDrafts()
  expect(get(messageRequests)).toEqual({ acceptedChats: {}, rejectedChats: {} })
  expect(expirationStore.getAllExpirations()).toEqual({})
  expect(getDraft('trusted-in-old-profile')).toBe('')
  expect(localStorage.getItem('iris-chat-message-request-decisions')).toBeNull()
  expect(localStorage.getItem('iris-chat-expirations')).toBeNull()
})

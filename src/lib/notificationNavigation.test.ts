import { describe, expect, it } from 'vitest'
import { notificationFromHash, notificationHash, notificationTarget, resolveNotificationTarget } from './notificationNavigation'

describe('notification destinations', () => {
  it('round trips chat and account through a cold-start URL without letting an ID change the route', () => {
    const target = { chatId: 'group/a?#b %', ownerPubkey: 'alice' }
    expect(notificationFromHash(notificationHash(target))).toEqual(target)
    expect(notificationFromHash('#chat-old%20chat')).toEqual({ chatId: 'old chat' })
    expect(notificationTarget({ chatId: 'group:room' })).toEqual({ chatId: 'room' })
    expect(notificationFromHash('#notification-%zz')).toBeNull()
    expect(notificationTarget({ chatId: '', ownerPubkey: 'alice' })).toBeNull()
  })
  it('waits for hydration, resolves both chat types, and rejects a different account', () => {
    const target = { chatId: 'room', ownerPubkey: 'alice' }
    expect(resolveNotificationTarget(target, 'alice', new Set(), new Set())).toBe('pending')
    expect(resolveNotificationTarget(target, 'alice', new Set(['room']), new Set())).toBe('chat')
    expect(resolveNotificationTarget(target, 'alice', new Set(), new Set(['room']))).toBe('group')
    expect(resolveNotificationTarget(target, 'bob', new Set(['room']), new Set(['room']))).toBe('discard')
  })
})

import { expect, it } from 'vitest'
import type { Event } from 'nostr-tools'
import { followListUpdate } from './followListUpdate'

it('preserves the public list content, unrelated tags, and follow metadata', () => {
  const friend = 'a'.repeat(64), person = 'b'.repeat(64)
  const head = { created_at: 10, content: '{"servers":true}', tags: [['p', friend, 'wss://example.com', 'friend'], ['x', 'extension']] } as Event
  const followed = followListUpdate(head, person, true, 10)
  expect(followed.created_at).toBe(11)
  expect(followed.content).toBe(head.content)
  expect(followed.tags).toEqual([...head.tags, ['p', person]])
  expect(followListUpdate(followed as Event, person, false, 10).tags).toEqual(head.tags)
  expect(followListUpdate(followed as Event, person, true, 10).tags).toEqual(followed.tags)
})

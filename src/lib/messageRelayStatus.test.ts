import { describe, expect, it } from 'vitest'
import {
  advanceRecipientStatus,
  mergeUniqueStrings,
  relayChannelLabel,
} from './messageRelayStatus'

describe('message delivery helpers', () => {
  it('trims, deduplicates, and sorts merged strings', () => {
    expect(mergeUniqueStrings([' wss://b ', 'wss://a'], ['wss://a', '', ' wss://c'])).toEqual([
      'wss://a',
      'wss://b',
      'wss://c',
    ])
  })

  it('formats relay delivery channels', () => {
    expect(relayChannelLabel(' wss://relay.example ')).toBe('message server: wss://relay.example')
  })

  it('advances recipient status without moving backwards', () => {
    expect(advanceRecipientStatus(undefined, 'alice', 'delivered')).toEqual({ alice: 'delivered' })
    expect(advanceRecipientStatus({ alice: 'delivered' }, 'alice', 'seen')).toEqual({ alice: 'seen' })
    expect(advanceRecipientStatus({ alice: 'seen' }, 'alice', 'delivered')).toBeNull()
  })
})
